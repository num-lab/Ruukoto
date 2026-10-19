#include <assert.h>
#include <errno.h>
#include <libproc.h>
#include <mach/message.h>
#include <stdint.h>
#include <string.h>

static int fake_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size);
static int fake_proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size);
static int fake_proc_signal_with_audittoken(audit_token_t *token, int signal);
#define proc_pidinfo fake_proc_pidinfo
#define proc_listpids fake_proc_listpids
#define proc_signal_with_audittoken fake_proc_signal_with_audittoken
#define main supervisor_main
#include "packages/agent/src/execution/native-macos-supervisor.c"
#undef main
#undef proc_pidinfo
#undef proc_listpids
#undef proc_signal_with_audittoken

enum query_mode { COMPLETE, DENIED, ABSENT, REUSED, EXECUTED };
enum list_mode { LIST_COMPLETE, LIST_NEEDED_ERROR, LIST_PARTIAL, LIST_SATURATED };
static enum query_mode query;
static enum list_mode listing;
static int signal_calls;
static uint32_t signaled_pid;
static int32_t signaled_version;
static pid_t candidate = 9123;

static struct process_info known(void) {
  struct process_info value = {0};
  value.bsd.pbi_pid = (uint32_t)candidate;
  value.bsd.pbi_status = 2;
  value.bsd.pbi_start_tvsec = 100;
  value.bsd.pbi_start_tvusec = 2;
  value.unique.uniqueid = 44;
  value.unique.pidversion = 7;
  return value;
}

static int fake_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer, int size) {
  (void)flavor; (void)arg;
  if (query == DENIED) { errno = EPERM; return 0; }
  if (query == ABSENT) { errno = ESRCH; return 0; }
  assert(size == sizeof(struct process_info));
  struct process_info value = known();
  value.bsd.pbi_pid = (uint32_t)pid;
  if (query == REUSED) value.unique.uniqueid++;
  if (query == EXECUTED) value.unique.pidversion++;
  memcpy(buffer, &value, sizeof(value));
  return size;
}

static int fake_proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer, int size) {
  (void)type; (void)typeinfo;
  if (!buffer) return listing == LIST_NEEDED_ERROR ? 0 : sizeof(pid_t);
  if (listing == LIST_PARTIAL) return sizeof(pid_t) - 1;
  if (listing == LIST_SATURATED) return size;
  memcpy(buffer, &candidate, sizeof(candidate));
  return sizeof(candidate);
}

static int fake_proc_signal_with_audittoken(audit_token_t *token, int signal) {
  assert(signal == SIGTERM);
  signal_calls++;
  signaled_pid = token->val[5];
  signaled_version = (int32_t)token->val[7];
  return 0;
}

static void reset(void) {
  uncertain = false;
  uncertain_reason = "none";
  last_sample = 0;
  query = COMPLETE;
  listing = LIST_COMPLETE;
  signal_calls = 0;
  members.length = 0;
  baseline.length = 0;
}

int main(void) {
  struct process_list current = {0};
  reset();
  query = DENIED;
  assert(!sample(&current));
  assert(members.length == 0);
  assert(uncertain && !strcmp(uncertain_reason, "identity_unavailable"));
  query = COMPLETE;
  assert(sample(&current));
  assert(uncertain && !strcmp(uncertain_reason, "identity_unavailable"));
  mark_uncertain("descendant_alive");
  assert(!strcmp(uncertain_reason, "identity_unavailable"));

  for (listing = LIST_NEEDED_ERROR; listing <= LIST_SATURATED; listing++) {
    enum list_mode mode = listing;
    reset();
    listing = mode;
    assert(!sample(&current));
    assert(uncertain && !strcmp(uncertain_reason, "identity_unavailable"));
  }

  reset();
  struct process_info expected = known();
  query = DENIED;
  signal_member(&expected, SIGTERM);
  assert(signal_calls == 0 && uncertain);
  reset();
  query = REUSED;
  signal_member(&expected, SIGTERM);
  assert(signal_calls == 0 && !uncertain);
  reset();
  query = ABSENT;
  signal_member(&expected, SIGTERM);
  assert(signal_calls == 0 && !uncertain);
  reset();
  query = EXECUTED;
  signal_member(&expected, SIGTERM);
  assert(signal_calls == 1 && !uncertain);
  assert(signaled_pid == expected.bsd.pbi_pid);
  assert(signaled_version == expected.unique.pidversion + 1);

  reset();
  assert(append(&members, &expected));
  query = DENIED;
  assert(alive_members() == 1);
  assert(uncertain && !strcmp(uncertain_reason, "identity_unavailable"));
  query = ABSENT;
  assert(alive_members() == 0);
  assert(uncertain && !strcmp(uncertain_reason, "identity_unavailable"));

  free(current.items);
  free(members.items);
  free(baseline.items);
  puts("caller invariants passed: nonmember/list failure sticky; unknown/reused/absent not signaled; exec token current; unknown alive remains uncertain");
  return 0;
}
