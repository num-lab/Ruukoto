/*
 * 宿主累计执行后代，用内核身份发送信号；未知新孤儿只报告，不认领或误杀。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md
 * Note: 见 .agents/notes/implemented/feature/2026-10-21-coding-background-processes.md
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
#include <errno.h>
#include <ApplicationServices/ApplicationServices.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/message.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <sys/file.h>
#include <uuid/uuid.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* 该 libproc flavor 不在 SDK 公共头中；返回大小不匹配时明确拒绝，不猜 ABI。 */
struct unique_info {
  uint8_t uuid[16];
  uint64_t uniqueid;
  uint64_t parent_uniqueid;
  int32_t pidversion;
  int32_t parent_pidversion;
  uint64_t reserved2;
  uint64_t reserved3;
};
struct process_info {
  struct proc_bsdinfo bsd;
  struct unique_info unique;
};
_Static_assert(sizeof(struct unique_info) == 56, "libproc unique ABI");
_Static_assert(sizeof(struct process_info) == 192, "libproc combined ABI");

struct process_list {
  struct process_info *items;
  size_t length;
  size_t capacity;
};
static struct process_list baseline;
static struct process_list members;
static struct process_info root;
static struct unique_info launchd;
static bool launchd_verified;
static pid_t worker_pid;
static volatile sig_atomic_t stop_requested;
static bool uncertain;
static const char *uncertain_reason = "none";
static double last_sample;
struct process_scope { uint32_t pid; uint32_t group; pid_t session; };
static struct process_scope *managed_scopes;
static size_t managed_scopes_length;
static size_t managed_scopes_capacity;
static bool durable;
static bool durable_stdio;
static int evidence_dir = -1;
static int journal = -1;
static const char *execution_token;
static const char *execution_fingerprint;
static int output_write[2] = {-1, -1};
struct output_pipe {
  int fd;
  unsigned char pending[65536];
  size_t length;
  bool eof;
  bool lost;
};
static struct output_pipe output[2] = {{.fd = -1}, {.fd = -1}};

static double monotonic(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
  return (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0;
}

static bool same_process(const struct process_info *left, const struct process_info *right) {
  return left->bsd.pbi_pid == right->bsd.pbi_pid && left->unique.uniqueid == right->unique.uniqueid &&
         left->bsd.pbi_start_tvsec == right->bsd.pbi_start_tvsec && left->bsd.pbi_start_tvusec == right->bsd.pbi_start_tvusec;
}

static bool pidversion_wrapped(uint32_t initial, uint32_t current) { return current < initial; }

/* uniqueid 在 fork 时单调分配，exec 保留；出生顺序不依赖可能回拨的墙钟。 */
static bool born_since_root(const struct process_info *value) {
  return root.unique.uniqueid != 0 && value->unique.uniqueid >= root.unique.uniqueid;
}

static bool zombie(const struct process_info *value) { return value->bsd.pbi_status == 5; }

/* 0 为已退出，1 为完整身份，-1 为无法核实。 */
static int identity(pid_t pid, struct process_info *value) {
  /* 查询失败有界重核；只有完整身份或明确 ESRCH 可以结束核实。 */
  for (int attempt = 0; attempt < 3; attempt++) {
    memset(value, 0, sizeof(*value)); errno = 0;
    int count = proc_pidinfo(pid, 18, 0, value, sizeof(*value));
    if (count == 0 && errno == ESRCH) return 0;
    if (count == sizeof(*value)) return value->bsd.pbi_pid == (uint32_t)pid && value->unique.uniqueid != 0 ? 1 : -1;
    if (count > 0 || attempt == 2) return -1;
    struct timespec delay = {.tv_nsec = 1000000}; nanosleep(&delay, NULL);
  }
  return -1;
}

/* flavor 18 要求同 UID；PID 1 的身份用可跨 UID 的 flavor 17，不读取环境或参数。 */
static bool launchd_identity(struct unique_info *value) {
  memset(value, 0, sizeof(*value));
  return proc_pidinfo(1, 17, 0, value, sizeof(*value)) == sizeof(*value) && value->uniqueid != 0;
}

static bool append(struct process_list *list, const struct process_info *value) {
  if (list->length == list->capacity) {
    size_t capacity = list->capacity ? list->capacity * 2 : 32;
    struct process_info *items = realloc(list->items, capacity * sizeof(*items));
    if (!items) return false;
    list->items = items;
    list->capacity = capacity;
  }
  list->items[list->length++] = *value;
  return true;
}

static bool contains(const struct process_list *list, const struct process_info *value) {
  for (size_t i = 0; i < list->length; i++) if (same_process(&list->items[i], value)) return true;
  return false;
}

static bool owner_processes(struct process_list *list) {
  list->length = 0;
  int needed = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (needed <= 0) return false;
  pid_t *pids = NULL;
  int count = 0;
  for (int attempt = 0; attempt < 4; attempt++) {
    size_t size = (size_t)needed + 64 * sizeof(pid_t);
    pid_t *grown = realloc(pids, size);
    if (!grown) { free(pids); return false; }
    pids = grown;
    count = proc_listpids(PROC_UID_ONLY, getuid(), pids, (int)size);
    if (count <= 0 || count % sizeof(pid_t) != 0) { free(pids); return false; }
    if ((size_t)count < size) break;
    needed = (int)(size * 2);
    if (attempt == 3) { free(pids); return false; }
  }
  for (size_t i = 0; i < (size_t)count / sizeof(pid_t); i++) {
    if (pids[i] <= 0) continue;
    struct process_info value;
    int result = identity(pids[i], &value);
    if (result < 0) { free(pids); return false; }
    if (result == 1 && !zombie(&value) && !append(list, &value)) { free(pids); return false; }
  }
  free(pids);
  return true;
}

static void mark_uncertain(const char *reason) {
  if (!uncertain) uncertain_reason = reason;
  uncertain = true;
}

static bool live_parent(const struct process_list *current, const struct process_info *child) {
  for (size_t i = 0; i < members.length; i++) {
    const struct process_info *parent = &members.items[i];
    /* 当前父 uniqueid 会随收养变化；仍直接归属已知父时，不只凭可复用的 ppid。 */
    if (child->unique.parent_uniqueid == parent->unique.uniqueid) return true;
    if (child->bsd.pbi_ppid != parent->bsd.pbi_pid) continue;
    for (size_t j = 0; j < current->length; j++) if (same_process(parent, &current->items[j])) return true;
  }
  return false;
}

static bool remember_scope(const struct process_info *value);

static bool sample(struct process_list *current) {
  double now = monotonic();
  if (now < 0 || (last_sample > 0 && now - last_sample > 0.25)) mark_uncertain("observation_interrupted");
  last_sample = now;
  if (!owner_processes(current)) { mark_uncertain("identity_unavailable"); return false; }
  bool group_trusted = false;
  for (size_t i = 0; i < current->length; i++) {
    const struct process_info *value = &current->items[i];
    if (!contains(&baseline, value) && (born_since_root(value) || contains(&members, value)) &&
        pidversion_wrapped((uint32_t)root.unique.pidversion, (uint32_t)value->unique.pidversion)) {
      mark_uncertain("pidversion_counter_wrapped");
    }
    if (contains(&members, value) && value->bsd.pbi_pgid == (uint32_t)worker_pid) group_trusted = true;
  }
  bool changed;
  do {
    changed = false;
    for (size_t i = 0; i < current->length; i++) {
      const struct process_info *value = &current->items[i];
      if (contains(&members, value)) continue;
      if (!live_parent(current, value) && !(group_trusted && value->bsd.pbi_pgid == (uint32_t)worker_pid)) continue;
      if (!append(&members, value)) { mark_uncertain("identity_storage_failed"); return false; }
      changed = true;
    }
  } while (changed);
  if (durable) for (size_t i = 0; i < current->length; i++) {
    const struct process_info *value = &current->items[i];
    if (contains(&members, value) && !remember_scope(value)) return false;
  }
  return true;
}

/* audit token 把 pidversion 的比较与 signal 放在同一个内核操作中。 */
static void signal_member(const struct process_info *expected, int sig) {
  struct process_info actual;
  int result = identity(expected->bsd.pbi_pid, &actual);
  if (result < 0) { mark_uncertain("identity_unavailable"); return; }
  if (result == 0 || zombie(&actual) || !same_process(expected, &actual)) return;
  audit_token_t token = {{0}};
  token.val[5] = actual.bsd.pbi_pid;
  token.val[7] = actual.unique.pidversion;
  int error = proc_signal_with_audittoken(&token, sig);
  /* exec 会改变 pidversion；ESRCH 后留给下一轮重新核实，不能据此记为退出。 */
  if (error != 0 && error != ESRCH) mark_uncertain("signal_denied");
}

static size_t alive_members(void) {
  size_t alive = 0;
  for (size_t i = 0; i < members.length; i++) {
    struct process_info actual;
    int result = identity(members.items[i].bsd.pbi_pid, &actual);
    if (result < 0) { mark_uncertain("identity_unavailable"); alive++; }
    else if (result == 1 && !zombie(&actual) && same_process(&members.items[i], &actual)) alive++;
  }
  return alive;
}

static bool remember_scope(const struct process_info *value) {
  pid_t session = getsid((pid_t)value->bsd.pbi_pid);
  struct process_info confirmed;
  int result = identity((pid_t)value->bsd.pbi_pid, &confirmed);
  if (result < 0 || (result == 1 && same_process(value, &confirmed) && session < 0)) { mark_uncertain("identity_unavailable"); return false; }
  if (result == 0 || !same_process(value, &confirmed)) session = 0;
  /* 根命令在 setsid 后才过启动门；此前快照属于宿主，不能污染后台范围。 */
  if (value->bsd.pbi_pid == (uint32_t)worker_pid && (value->bsd.pbi_pgid != (uint32_t)worker_pid || session != worker_pid)) return true;
  for (size_t i = 0; i < managed_scopes_length; i++) if (managed_scopes[i].pid == value->bsd.pbi_pid && managed_scopes[i].group == value->bsd.pbi_pgid && managed_scopes[i].session == session) return true;
  if (managed_scopes_length == managed_scopes_capacity) {
    size_t capacity = managed_scopes_capacity ? managed_scopes_capacity * 2 : 32;
    struct process_scope *items = realloc(managed_scopes, capacity * sizeof(*items));
    if (!items) { mark_uncertain("identity_storage_failed"); return false; }
    managed_scopes = items; managed_scopes_capacity = capacity;
  }
  managed_scopes[managed_scopes_length++] = (struct process_scope){.pid = value->bsd.pbi_pid, .group = value->bsd.pbi_pgid, .session = session};
  return true;
}

static bool managed_scope(const struct process_info *value, pid_t session) {
  if (value->bsd.pbi_pgid == (uint32_t)worker_pid || session == worker_pid) return true;
  for (size_t i = 0; i < managed_scopes_length; i++) {
    const struct process_scope *scope = &managed_scopes[i];
    if (value->bsd.pbi_pgid == scope->group || value->bsd.pbi_pgid == scope->pid || session == scope->session || (uint32_t)session == scope->pid) return true;
  }
  return false;
}

static bool new_orphan(const struct process_list *current, bool report) {
  for (size_t i = 0; i < current->length; i++) {
    const struct process_info *value = &current->items[i];
    if (value->bsd.pbi_ppid != 1 || contains(&baseline, value) || contains(&members, value)) continue;
    /* 当前父为 PID 1，且不可变原父版本也匹配；只排除 launchd 直接创建的任务。 */
    if (launchd_verified && (uint32_t)root.unique.pidversion > (uint32_t)launchd.pidversion &&
        value->unique.parent_uniqueid == launchd.uniqueid &&
        value->unique.parent_pidversion == launchd.pidversion) continue;
    if (durable) {
      pid_t session = getsid((pid_t)value->bsd.pbi_pid);
      struct process_info confirmed;
      int result = identity((pid_t)value->bsd.pbi_pid, &confirmed);
      if (result < 0 || (result == 1 && same_process(value, &confirmed) && session < 0)) { mark_uncertain("identity_unavailable"); return true; }
      if (result == 0 || !same_process(value, &confirmed) || zombie(&confirmed)) continue;
      /* 历史组、会话与已知 PID 只增加保守拒绝，绝不据这些可复用数字发信号。 */
      if (!managed_scope(value, session)) continue;
    }
    if (born_since_root(value)) {
      if (report) fprintf(stderr, "[ruukoto:native] 新孤儿 pid=%u (%.*s) 的执行归属不可核实，未发送信号\n", value->bsd.pbi_pid, (int)sizeof(value->bsd.pbi_comm), value->bsd.pbi_comm);
      return true;
    }
  }
  return false;
}

static void request_stop(int sig) { (void)sig; stop_requested = 1; }

static bool check_capability(void) {
  if (!pidversion_wrapped(UINT32_MAX, 1) || pidversion_wrapped(41, 42) ||
      pidversion_wrapped(41, 41) || pidversion_wrapped(INT32_MAX, (uint32_t)INT32_MAX + 1)) return false;
  struct process_info self;
  if (identity(getpid(), &self) != 1) return false;
  audit_token_t wrong = {{0}};
  wrong.val[5] = getpid();
  wrong.val[7] = (uint32_t)self.unique.pidversion ^ 1;
  return proc_signal_with_audittoken(&wrong, SIGTERM) == ESRCH;
}

static bool host_identity(char machine[37], char boot[128]) {
  uuid_t machine_uuid;
  struct timespec timeout = {.tv_sec = 1};
  size_t size = 128;
  if (gethostuuid(machine_uuid, &timeout) != 0 || sysctlbyname("kern.bootsessionuuid", boot, &size, NULL, 0) != 0 || size < 2 || size > 128 || boot[size - 1] != 0) return false;
  uuid_unparse_lower(machine_uuid, machine);
  return true;
}

static bool private_stat(int fd, bool directory) {
  struct stat value;
  return fstat(fd, &value) == 0 && value.st_uid == getuid() && (value.st_mode & 077) == 0 &&
    (directory ? S_ISDIR(value.st_mode) : S_ISREG(value.st_mode) && value.st_nlink == 1);
}

static bool write_all(int fd, const char *bytes, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t size = write(fd, bytes + written, length - written);
    if (size < 0 && errno == EINTR) continue;
    if (size <= 0) return false;
    written += (size_t)size;
  }
  return true;
}

static bool persist(const char *bytes) {
  if (write_all(journal, bytes, strlen(bytes)) && fsync(journal) == 0) return true;
  mark_uncertain("supervisor_evidence_failed"); stop_requested = 1;
  return false;
}

/* 宿主读取有背压时只保留有界缓冲，持续核实进程；断管后排空原管道再确认 EOF。 */
static void capture_output(void) {
  if (!durable) return;
  for (int stream = 0; stream < 2; stream++) {
    struct output_pipe *pipe = &output[stream];
    if (pipe->length && !pipe->lost) {
      ssize_t written = write(stream + 1, pipe->pending, pipe->length);
      if (written > 0) {
        pipe->length -= (size_t)written;
        memmove(pipe->pending, pipe->pending + written, pipe->length);
      } else if (written < 0 && errno != EINTR && errno != EAGAIN) { pipe->lost = true; stop_requested = 1; }
    }
    if (pipe->lost) pipe->length = 0;
    if (pipe->eof || pipe->fd < 0 || pipe->length == sizeof(pipe->pending)) continue;
    ssize_t received = read(pipe->fd, pipe->pending + pipe->length, sizeof(pipe->pending) - pipe->length);
    if (received > 0) pipe->length += (size_t)received;
    else if (received == 0) { pipe->eof = true; close(pipe->fd); pipe->fd = -1; }
    else if (errno != EINTR && errno != EAGAIN) { mark_uncertain("output_pipe_unavailable"); stop_requested = 1; }
  }
}

static bool output_finished(void) {
  if (!durable) return true;
  return output[0].eof && output[1].eof && output[0].length == 0 && output[1].length == 0;
}

static bool finish_output(void) {
  if (!durable) return true;
  for (int stream = 0; stream < 2; stream++) if (output_write[stream] >= 0) { close(output_write[stream]); output_write[stream] = -1; }
  double deadline = monotonic() + 1.0;
  while (!output_finished() && monotonic() >= 0 && monotonic() < deadline) {
    capture_output(); struct timespec delay = {.tv_nsec = 1000000}; nanosleep(&delay, NULL);
  }
  /* 停止后宿主仍不读时放弃未交付预览；原管道 EOF 仍须核实。 */
  if (!output_finished()) {
    for (int stream = 0; stream < 2; stream++) if (output[stream].length) output[stream].lost = true;
    deadline = monotonic() + 1.0;
    while (!output_finished() && monotonic() >= 0 && monotonic() < deadline) {
      capture_output(); struct timespec delay = {.tv_nsec = 1000000}; nanosleep(&delay, NULL);
    }
  }
  if (!output_finished()) { mark_uncertain("output_pipe_not_closed"); return false; }
  return true;
}

static bool stop_marker(void) {
  if (!durable) return false;
  struct stat value;
  if (fstatat(evidence_dir, "stop-requested", &value, AT_SYMLINK_NOFOLLOW) == 0) return true;
  if (errno == ENOENT) return false;
  mark_uncertain("stop_marker_unavailable");
  return true;
}

static bool prepare_durable(const char *directory, const char *token, const char *fingerprint) {
  if (strlen(token) != 32 || strspn(token, "0123456789abcdef") != 32 || strlen(fingerprint) != 64 || strspn(fingerprint, "0123456789abcdef") != 64) return false;
  execution_token = token; execution_fingerprint = fingerprint;
  evidence_dir = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (evidence_dir < 0 || !private_stat(evidence_dir, true)) return false;
  journal = openat(evidence_dir, "supervisor.jsonl", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (journal < 0 || !private_stat(journal, false) || flock(journal, LOCK_EX | LOCK_NB) != 0 || fsync(evidence_dir) != 0) return false;
  struct process_info self;
  struct stat directory_stat;
  char machine[37], boot[128], line[1024];
  if (identity(getpid(), &self) != 1 || !host_identity(machine, boot) || fstat(evidence_dir, &directory_stat) != 0) return false;
  snprintf(line, sizeof(line), "{\"type\":\"supervisor\",\"token\":\"%s\",\"fingerprint\":\"%s\",\"machineId\":\"%s\",\"bootId\":\"%s\",\"directoryDev\":\"%llu\",\"directoryIno\":\"%llu\",\"pid\":%u,\"uniqueid\":\"%llu\",\"seconds\":\"%llu\",\"microseconds\":\"%llu\",\"pidversion\":%d}\n", token, fingerprint, machine, boot, (unsigned long long)directory_stat.st_dev, (unsigned long long)directory_stat.st_ino, self.bsd.pbi_pid, self.unique.uniqueid, self.bsd.pbi_start_tvsec, self.bsd.pbi_start_tvusec, self.unique.pidversion);
  if (!persist(line)) return false;
  for (int stream = 0; stream < 2; stream++) {
    int pair[2];
    if (pipe(pair) != 0) return false;
    output[stream].fd = pair[0]; output_write[stream] = pair[1];
    if (fcntl(pair[0], F_SETFD, FD_CLOEXEC) != 0 || fcntl(pair[1], F_SETFD, FD_CLOEXEC) != 0 || fcntl(pair[0], F_SETFL, O_NONBLOCK) != 0 || fcntl(stream + 1, F_SETFL, O_NONBLOCK) != 0) return false;
  }
  return true;
}

static bool write_receipt(const char *line) {
  int fd = openat(evidence_dir, "stopped.pending", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return false;
  bool saved = write_all(fd, line, strlen(line)) && fsync(fd) == 0;
  if (close(fd) != 0) saved = false;
  return saved && renameatx_np(evidence_dir, "stopped.pending", evidence_dir, "stopped.json", RENAME_EXCL) == 0 && fsync(evidence_dir) == 0;
}

static bool started_message(pid_t pid) {
  char line[128];
  snprintf(line, sizeof(line), "{\"type\":\"started\",\"pid\":%d}\n", pid);
  if (durable && !persist(line)) return false;
  return durable_stdio || dprintf(3, "%s", line) > 0;
}

static bool parse_unsigned(const char *source, uint64_t *value) {
  if (!*source || strspn(source, "0123456789") != strlen(source)) return false;
  char *end;
  errno = 0; unsigned long long parsed = strtoull(source, &end, 10);
  if (errno || *end) return false;
  *value = parsed; return true;
}

/* 只接受完整寿命身份；exec 换代也拒绝，signal 的 pidversion 比较由内核原子完成。 */
static int signal_supervisor(int argc, char **argv) {
  if (argc != 9) return 2;
  char machine[37], boot[128];
  uint64_t values[5];
  if (!host_identity(machine, boot) || strcmp(machine, argv[2]) || strcmp(boot, argv[3])) return 3;
  for (int i = 0; i < 5; i++) if (!parse_unsigned(argv[i + 4], &values[i])) return 2;
  if (values[0] == 0 || values[0] > INT32_MAX || values[4] > UINT32_MAX) return 2;
  struct process_info actual;
  if (identity((pid_t)values[0], &actual) != 1 || actual.unique.uniqueid != values[1] || actual.bsd.pbi_start_tvsec != values[2] || actual.bsd.pbi_start_tvusec != values[3] || (uint32_t)actual.unique.pidversion != values[4] || zombie(&actual)) return 3;
  audit_token_t token = {{0}}; token.val[5] = actual.bsd.pbi_pid; token.val[7] = actual.unique.pidversion;
  return proc_signal_with_audittoken(&token, SIGTERM) == 0 ? 0 : 3;
}

static bool status_message(const char *type, const char *reason, int reaped) {
  char line[1024];
  if (durable && reaped >= 0) {
    bool pipes = finish_output();
    if (!pipes) { reaped = 0; reason = uncertain_reason; }
    snprintf(line, sizeof(line), "{\"type\":\"%s\",\"token\":\"%s\",\"fingerprint\":\"%s\",\"reaped\":%s,\"reason\":\"%s\",\"stdoutEof\":%s,\"stderrEof\":%s,\"outputComplete\":%s}\n", type, execution_token, execution_fingerprint, reaped ? "true" : "false", reason, output[0].eof ? "true" : "false", output[1].eof ? "true" : "false", output[0].lost || output[1].lost ? "false" : "true");
    if (!write_receipt(line)) { mark_uncertain("supervisor_receipt_failed"); return false; }
  } else if (reaped < 0) snprintf(line, sizeof(line), "{\"type\":\"%s\",\"reason\":\"%s\"}\n", type, reason);
  else snprintf(line, sizeof(line), "{\"type\":\"%s\",\"reaped\":%s,\"reason\":\"%s\"}\n", type, reaped ? "true" : "false", reason);
  return durable_stdio || dprintf(3, "%s", line) > 0;
}

static void pause_observation(int milliseconds) {
  capture_output();
  if (stop_marker()) stop_requested = 1;
  if (durable_stdio) {
    struct timespec delay = {.tv_sec = milliseconds / 1000, .tv_nsec = (milliseconds % 1000) * 1000000};
    nanosleep(&delay, NULL);
    return;
  }
  struct pollfd controller = {.fd = 4, .events = POLLIN | POLLHUP};
  int result = poll(&controller, 1, milliseconds);
  if (result < 0 && errno != EINTR) { mark_uncertain("controller_unavailable"); stop_requested = 1; }
  if (result > 0 && (controller.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) {
    char command[32];
    ssize_t size = read(4, command, sizeof(command));
    if (size >= 0) stop_requested = 1;
    else if (errno != EINTR && errno != EAGAIN) { mark_uncertain("controller_unavailable"); stop_requested = 1; }
  }
}

static bool stop_worker(void) {
  struct process_list current = {0};
  if (monotonic() < 0) mark_uncertain("clock_unavailable");
  for (int phase = 0; phase < 2; phase++) {
    double deadline = monotonic() + (phase == 0 ? 1.0 : 3.0);
    for (;;) {
      capture_output();
      bool sampled = sample(&current);
      if (sampled && alive_members() == 0) break;
      for (size_t i = 0; i < members.length; i++) signal_member(&members.items[i], phase == 0 ? SIGTERM : SIGKILL);
      if (monotonic() >= deadline || monotonic() < 0) break;
      struct timespec delay = {.tv_nsec = 10000000};
      nanosleep(&delay, NULL);
    }
  }
  /* 给短命后代 100ms 自行收敛；最终连续完整快照核实，未知归属始终不发送信号。 */
  double settle_deadline = monotonic() + 0.1;
  int clean_samples = 0;
  for (int i = 0; i < 16; i++) {
    bool complete = sample(&current);
    bool orphan = complete && new_orphan(&current, false);
    clean_samples = complete && !orphan && alive_members() == 0 ? clean_samples + 1 : 0;
    if (monotonic() >= settle_deadline || monotonic() < 0 || i == 15) {
      if (orphan) { new_orphan(&current, true); mark_uncertain("unknown_new_orphan"); }
      else if (clean_samples < 2) mark_uncertain("exit_not_settled");
      break;
    }
    struct timespec delay = {.tv_nsec = 10000000};
    nanosleep(&delay, NULL);
  }
  size_t alive = alive_members();
  if (alive > 0) mark_uncertain("descendant_alive");
  bool reaped = !uncertain && alive == 0;
  free(current.items);
  return reaped;
}

int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  if (argc == 2 && strcmp(argv[1], "--cua-permissions") == 0) {
    printf("{\"accessibility\":%s,\"screenRecording\":%s}\n", AXIsProcessTrusted() ? "true" : "false", CGPreflightScreenCaptureAccess() ? "true" : "false");
    return 0;
  }
  if (argc >= 2 && strcmp(argv[1], "--signal-supervisor") == 0) return signal_supervisor(argc, argv);
  if (argc == 2 && strcmp(argv[1], "--host-identity") == 0) {
    char machine[37], boot[128];
    if (!host_identity(machine, boot) || !check_capability()) return 2;
    printf("{\"machineId\":\"%s\",\"bootId\":\"%s\"}\n", machine, boot); return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--check") == 0) {
    if (check_capability()) {
      struct unique_info parent;
      printf("{\"launchdVerified\":%s}\n", launchd_identity(&parent) ? "true" : "false");
      return 0;
    }
    fprintf(stderr, "[ruukoto:native] libproc 身份或原子信号能力不可用\n");
    return 2;
  }
  int command_index = 2;
  durable_stdio = argc >= 7 && strcmp(argv[1], "--durable-stdio") == 0 && strcmp(argv[5], "--") == 0;
  durable = durable_stdio || (argc >= 7 && strcmp(argv[1], "--durable") == 0 && strcmp(argv[5], "--") == 0);
  if (durable) command_index = 6;
  if (argc <= command_index || (!durable && strcmp(argv[1], "--") != 0) || (!durable_stdio && (fcntl(3, F_GETFD) < 0 || fcntl(4, F_GETFD) < 0))) return 2;
  signal(SIGTERM, request_stop);
  signal(SIGINT, request_stop);
  signal(SIGHUP, request_stop);
  if (!durable_stdio) {
    fcntl(3, F_SETFD, FD_CLOEXEC);
    fcntl(4, F_SETFD, FD_CLOEXEC);
  }
  if (durable && !prepare_durable(argv[2], argv[3], argv[4])) return 2;
  if (!check_capability() || !owner_processes(&baseline)) {
    status_message("failed", "capability_or_baseline_unavailable", -1);
    status_message("stopped", "not_created", 1);
    free(baseline.items);
    return 2;
  }
  launchd_verified = launchd_identity(&launchd);
  int gate[2];
  if (pipe(gate) < 0) {
    status_message("failed", "startup_pipe_unavailable", -1);
    status_message("stopped", "not_created", 1);
    free(baseline.items);
    return 2;
  }
  fcntl(gate[0], F_SETFD, FD_CLOEXEC);
  fcntl(gate[1], F_SETFD, FD_CLOEXEC);
  if (durable && stop_marker()) {
    status_message("stopped", "not_created", 1);
    return 0;
  }
  worker_pid = fork();
  if (worker_pid == 0) {
    close(gate[1]);
    if (durable) {
      close(output[0].fd); close(output[1].fd);
      if (dup2(output_write[0], 1) < 0 || dup2(output_write[1], 2) < 0) _exit(126);
      close(output_write[0]); close(output_write[1]);
    }
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (setsid() < 0) _exit(126);
    char start;
    ssize_t size;
    do { size = read(gate[0], &start, 1); } while (size < 0 && errno == EINTR);
    if (size != 1) _exit(126);
    if (!durable_stdio) { close(3); close(4); }
    close(gate[0]);
    execv(argv[command_index], argv + command_index);
    _exit(127);
  }
  close(gate[0]);
  if (durable) for (int stream = 0; stream < 2; stream++) { close(output_write[stream]); output_write[stream] = -1; }
  if (worker_pid < 0) {
    close(gate[1]);
    status_message("failed", "fork_unavailable", -1);
    status_message("stopped", "not_created", 1);
    free(baseline.items);
    return 2;
  }
  if (identity(worker_pid, &root) != 1 || !append(&members, &root)) {
    /* gate 未放行，子进程尚未 exec；仍按精确身份回收，不用裸 PID 补位。 */
    mark_uncertain("startup_identity_unavailable");
    stop_requested = 1;
    status_message("failed", uncertain_reason, -1);
  } else if (!started_message(worker_pid)) stop_requested = 1;
  if (durable) pause_observation(0);
  if (!stop_requested && write(gate[1], "s", 1) != 1) stop_requested = 1;
  close(gate[1]);
  struct process_list current = {0};
  int child_status = 0;
  bool child_exited = false;
  last_sample = monotonic();
  while (!stop_requested) {
    sample(&current);
    pid_t result = waitpid(worker_pid, &child_status, WNOHANG);
    if (result == worker_pid) { child_exited = true; break; }
    if (result < 0 && errno != EINTR) { mark_uncertain("worker_wait_unavailable"); break; }
    pause_observation(10);
  }
  free(current.items);
  bool reaped = stop_worker();
  if (!finish_output()) reaped = false;
  status_message("stopped", reaped ? "verified" : uncertain_reason, reaped);
  if (!reaped) fprintf(stderr, "[ruukoto:native] 执行停止未核实（%s）；保留目录占用，等待拥有者核实\n", uncertain_reason);
  if (!child_exited) waitpid(worker_pid, &child_status, WNOHANG);
  free(baseline.items);
  free(members.items);
  free(managed_scopes);
  if (child_exited && WIFEXITED(child_status)) return WEXITSTATUS(child_status);
  if (child_exited && WIFSIGNALED(child_status)) return 128 + WTERMSIG(child_status);
  return 0;
}
