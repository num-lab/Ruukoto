#include <assert.h>
#include <errno.h>
#include <libproc.h>

static int fake_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size);
#define proc_pidinfo fake_proc_pidinfo
#define main supervisor_main
#include "packages/agent/src/execution/native-macos-supervisor.c"
#undef main
#undef proc_pidinfo

enum scenario { ABSENT, TRANSIENT_EXIT, DENIED, TRANSIENT_COMPLETE, BAD_PID, MISSING_ID, PARTIAL };
static enum scenario current;
static int calls;

static int fake_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)flavor; (void)arg; calls++;
  if (current == ABSENT || (current == TRANSIENT_EXIT && calls == 3)) { errno = ESRCH; return 0; }
  if (current == TRANSIENT_EXIT || current == DENIED || (current == TRANSIENT_COMPLETE && calls == 1)) { errno = EPERM; return 0; }
  if (current == PARTIAL) return size - 1;
  struct process_info *value = buffer;
  value->bsd.pbi_pid = current == BAD_PID ? (uint32_t)(pid + 1) : (uint32_t)pid;
  value->unique.uniqueid = current == MISSING_ID ? 0 : 1;
  return size;
}

int main(void) {
  const int results[] = {0, 0, -1, 1, -1, -1, -1};
  const int counts[] = {1, 3, 3, 2, 1, 1, 1};
  for (current = ABSENT; current <= PARTIAL; current++) {
    struct process_info value; calls = 0;
    assert(identity(123, &value) == results[current]);
    assert(calls == counts[current]);
  }
  puts("七项身份重查与拒绝检查通过");
  return 0;
}
