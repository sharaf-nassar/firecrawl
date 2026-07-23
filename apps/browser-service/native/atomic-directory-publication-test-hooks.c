#define _GNU_SOURCE

#include "atomic-directory-publication-test-hooks.h"

#include <errno.h>
#include <fcntl.h>
#include <linux/if_alg.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <uv.h>

#ifndef ATOMIC_PUBLISH_FAULT_VARIANT
#define ATOMIC_PUBLISH_FAULT_VARIANT 0
#endif

#if ATOMIC_PUBLISH_FAULT_VARIANT < 0 || ATOMIC_PUBLISH_FAULT_VARIANT > 34
#error "ATOMIC_PUBLISH_FAULT_VARIANT must be between 0 and 34"
#endif

enum {
  ATOMIC_FAULT_NONE = 0,
  ATOMIC_FAULT_NAPI_PROMISE = 1,
  ATOMIC_FAULT_NAPI_REFERENCE = 2,
  ATOMIC_FAULT_NAPI_ASYNC_CREATE = 3,
  ATOMIC_FAULT_NAPI_ASYNC_QUEUE = 4,
  ATOMIC_FAULT_PIDFD_SIGNAL = 5,
  ATOMIC_FAULT_WAIT = 6,
  ATOMIC_FAULT_DEADLINE = 7,
  ATOMIC_FAULT_CLAIM_EXTERNAL = 8,
  ATOMIC_FAULT_CLAIM_REFERENCE = 9,
  ATOMIC_FAULT_CLAIM_TIMER_INIT = 10,
  ATOMIC_FAULT_CLAIM_TIMER_START = 11,
  ATOMIC_FAULT_PHASE_GRACEFUL = 12,
  ATOMIC_FAULT_PHASE_TERM = 13,
  ATOMIC_FAULT_PHASE_KILL = 14,
  ATOMIC_FAULT_POST_KILL_TIMEOUT = 15,
  ATOMIC_FAULT_AUDIT_CREATE = 16,
  ATOMIC_FAULT_SETTLEMENT_HANDLE_SCOPE = 17,
  ATOMIC_FAULT_SETTLEMENT_OBJECT = 18,
  ATOMIC_FAULT_SETTLEMENT_PROPERTY = 19,
  ATOMIC_FAULT_SETTLEMENT_RESOLVE = 20,
  ATOMIC_FAULT_SETTLEMENT_REJECT = 21,
  ATOMIC_FAULT_SETTLEMENT_OWNER_INIT = 22,
  ATOMIC_FAULT_SETTLEMENT_OWNER_START = 23,
  ATOMIC_FAULT_SETTLEMENT_OWNER_REF = 24,
  ATOMIC_FAULT_PREAUTHORITY_REF_DELETE = 25,
  ATOMIC_FAULT_AUDIT_CLEANUP_PROMISE = 26,
  ATOMIC_FAULT_AUDIT_LIFECYCLE_PROMISE = 27,
  ATOMIC_FAULT_AUDIT_CLOSE_EXTERNAL = 28,
  ATOMIC_FAULT_AUDIT_CLOSE_TYPEDARRAY = 29,
  ATOMIC_FAULT_AUDIT_PROPERTY = 30,
  ATOMIC_FAULT_AUDIT_REFERENCE = 31,
  ATOMIC_FAULT_SETUP_RESOLVE = 32,
  ATOMIC_FAULT_PREAUTHORITY_DEFERRED_SETTLE = 33,
  ATOMIC_FAULT_LIFECYCLE_SCOPE_CLOSE = 34,
};

typedef struct settlement_close_state {
  uint32_t counters[2];
  unsigned references;
} settlement_close_state;

typedef struct setup_audit_state {
  uint32_t counters[32];
  unsigned references;
} setup_audit_state;

enum {
  SETUP_AUDIT_TERMINAL = 0,
  SETUP_AUDIT_EXTERNAL_CREATE_REQUESTS = 1,
  SETUP_AUDIT_EXTERNAL_CREATE_COMPLETIONS = 2,
  SETUP_AUDIT_OWNER_REF_CREATE_REQUESTS = 3,
  SETUP_AUDIT_OWNER_REF_CREATE_COMPLETIONS = 4,
  SETUP_AUDIT_SETTLEMENT_OWNER_INIT_REQUESTS = 5,
  SETUP_AUDIT_SETTLEMENT_OWNER_INIT_COMPLETIONS = 6,
  SETUP_AUDIT_SETTLEMENT_OWNER_INIT_FAILURES = 7,
  SETUP_AUDIT_SETTLEMENT_OWNER_START_REQUESTS = 8,
  SETUP_AUDIT_SETTLEMENT_OWNER_START_COMPLETIONS = 9,
  SETUP_AUDIT_SETTLEMENT_OWNER_START_FAILURES = 10,
  SETUP_AUDIT_SETTLEMENT_OWNER_REF_REQUESTS = 11,
  SETUP_AUDIT_SETTLEMENT_OWNER_REF_COMPLETIONS = 12,
  SETUP_AUDIT_SETTLEMENT_OWNER_REF_FAILURES = 13,
  SETUP_AUDIT_SETTLEMENT_OWNER_CLOSE_REQUESTS = 14,
  SETUP_AUDIT_SETTLEMENT_OWNER_CLOSE_COMPLETIONS = 15,
  SETUP_AUDIT_PREAUTHORITY_REF_DELETE_REQUESTS = 16,
  SETUP_AUDIT_PREAUTHORITY_REF_DELETE_FAILURES = 17,
  SETUP_AUDIT_PREAUTHORITY_REF_DELETE_COMPLETIONS = 18,
  SETUP_AUDIT_PREAUTHORITY_REF_DELETE_RETRIES = 19,
  SETUP_AUDIT_DEFERRED_SETTLE_REQUESTS = 20,
  SETUP_AUDIT_DEFERRED_SETTLE_FAILURES = 21,
  SETUP_AUDIT_DEFERRED_SETTLE_COMPLETIONS = 22,
  SETUP_AUDIT_SETUP_SETTLE_REQUESTS = 23,
  SETUP_AUDIT_SETUP_SETTLE_FAILURES = 24,
  SETUP_AUDIT_SETUP_SETTLE_COMPLETIONS = 25,
  SETUP_AUDIT_SETUP_RESULT_REF_DELETE_REQUESTS = 26,
  SETUP_AUDIT_SETUP_RESULT_REF_DELETE_FAILURES = 27,
  SETUP_AUDIT_SETUP_RESULT_REF_DELETE_COMPLETIONS = 28,
  SETUP_AUDIT_MANDATORY_DEFERREDS_CREATED = 29,
  SETUP_AUDIT_MANDATORY_DEFERREDS_SETTLED = 30,
  SETUP_AUDIT_PREAUTHORITY_SETTLEMENT_RETRIES = 31,
};

typedef struct atomic_claim {
  const void *owner;
  pid_t pid;
  int pidfd;
  int started;
  int settled;
  int wait_status;
  int failure;
  const char *failure_category;
  napi_deferred deferred;
  napi_async_work work;
  napi_ref promise_ref;
  napi_ref handle_ref;
  napi_ref audit_ref;
  napi_deferred cleanup_deferred;
  napi_deferred lifecycle_deferred;
  napi_deferred setup_deferred;
  napi_ref setup_result_ref;
  napi_env env;
  uv_timer_t cleanup_timer;
  uv_timer_t settlement_timer;
  int cleanup_timer_initialized;
  int cleanup_timer_close_requested;
  int cleanup_timer_closed;
  int cleanup_mode;
  int cleanup_stop;
  int cleanup_failure;
  int cleanup_reaped;
  int settlement_timer_initialized;
  int settlement_timer_close_requested;
  int settlement_timer_closed;
  int async_completion_received;
  int primary_settlement_pending;
  int audit_prepared;
  int external_finalized;
  int external_created;
  int preauthority_cleanup;
  int setup_failure_pending;
  int preauthority_ref_delete_fault_consumed;
  int preauthority_deferred_fault_consumed;
  int lifecycle_settled;
  int lifecycle_fault_consumed;
  int lifecycle_freeze_fault_consumed;
  int lifecycle_ref_delete_fault_consumed;
  int lifecycle_scope_close_fault_consumed;
  int fault_consumed;
  int published;
  int post_kill_barrier_state;
  int cleanup_completion_resolved;
  unsigned wait_attempts;
  unsigned signal_attempts;
  unsigned term_signal_attempts;
  unsigned kill_signal_attempts;
  unsigned deadline_attempts;
  unsigned cleanup_close_requests;
  unsigned cleanup_exact_reaps;
  unsigned post_kill_barrier_releases;
  unsigned pidfd_close_requests;
  unsigned pidfd_close_completions;
  unsigned async_work_delete_requests;
  unsigned async_work_delete_completions;
  unsigned promise_ref_release_requests;
  unsigned promise_ref_release_completions;
  unsigned handle_ref_release_requests;
  unsigned handle_ref_release_completions;
  unsigned external_finalizer_calls;
  unsigned cleanup_timer_close_completions;
  unsigned settlement_owner_close_requests;
  unsigned settlement_owner_close_completions;
  unsigned settlement_owner_init_requests;
  unsigned settlement_owner_init_completions;
  unsigned settlement_owner_init_failures;
  unsigned settlement_owner_start_requests;
  unsigned settlement_owner_start_completions;
  unsigned settlement_owner_start_failures;
  unsigned settlement_owner_ref_requests;
  unsigned settlement_owner_ref_completions;
  unsigned settlement_owner_ref_failures;
  unsigned external_create_requests;
  unsigned external_create_completions;
  unsigned owner_ref_create_requests;
  unsigned owner_ref_create_completions;
  unsigned settlement_attempts;
  unsigned settlement_retries;
  unsigned lifecycle_attempts;
  unsigned lifecycle_retries;
  unsigned lifecycle_handle_scope_failures;
  unsigned lifecycle_handle_scope_close_failures;
  unsigned lifecycle_object_failures;
  unsigned lifecycle_property_failures;
  unsigned lifecycle_freeze_failures;
  unsigned lifecycle_resolve_failures;
  unsigned lifecycle_ref_delete_failures;
  unsigned preauthority_ref_delete_attempts;
  unsigned preauthority_ref_delete_failures;
  unsigned preauthority_ref_delete_completions;
  unsigned preauthority_ref_delete_retries;
  unsigned preauthority_deferred_settle_requests;
  unsigned preauthority_deferred_settle_failures;
  unsigned preauthority_deferred_settle_completions;
  unsigned setup_deferred_settle_requests;
  unsigned setup_deferred_settle_failures;
  unsigned setup_deferred_settle_completions;
  unsigned setup_result_ref_delete_requests;
  unsigned setup_result_ref_delete_failures;
  unsigned setup_result_ref_delete_completions;
  unsigned mandatory_deferreds_created;
  unsigned mandatory_deferreds_settled;
  unsigned preauthority_settlement_retries;
  settlement_close_state *settlement_close_state;
  setup_audit_state *setup_audit_state;
  struct atomic_claim *next;
} atomic_claim;

static void settlement_owner_poll(uv_timer_t *timer);

static int consume_fault(atomic_claim *claim, int variant) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT != variant) {
    return 0;
  }
  return __atomic_exchange_n(&claim->fault_consumed, 1, __ATOMIC_ACQ_REL) == 0;
}

static napi_status atomic_create_promise(atomic_claim *claim, napi_env env,
                                         napi_deferred *deferred,
                                         napi_value *promise) {
  if (consume_fault(claim, ATOMIC_FAULT_NAPI_PROMISE)) {
    return napi_generic_failure;
  }
  return napi_create_promise(env, deferred, promise);
}

static napi_status atomic_create_audit_promise(atomic_claim *claim,
                                               napi_env env, int variant,
                                               napi_deferred *deferred,
                                               napi_value *promise) {
  if (consume_fault(claim, variant)) {
    return napi_generic_failure;
  }
  return napi_create_promise(env, deferred, promise);
}

static napi_status atomic_create_audit_external_arraybuffer(
    atomic_claim *claim, napi_env env, void *data, size_t length,
    napi_finalize finalizer, void *hint, napi_value *arraybuffer) {
  if (consume_fault(claim, ATOMIC_FAULT_AUDIT_CLOSE_EXTERNAL)) {
    return napi_generic_failure;
  }
  return napi_create_external_arraybuffer(env, data, length, finalizer, hint,
                                          arraybuffer);
}

static napi_status atomic_create_audit_typedarray(
    atomic_claim *claim, napi_env env, napi_value arraybuffer,
    napi_value *typedarray) {
  if (consume_fault(claim, ATOMIC_FAULT_AUDIT_CLOSE_TYPEDARRAY)) {
    return napi_generic_failure;
  }
  return napi_create_typedarray(env, napi_uint32_array, 2, arraybuffer, 0,
                                typedarray);
}

static napi_status atomic_set_audit_property(atomic_claim *claim, napi_env env,
                                             napi_value audit,
                                             const char *name,
                                             napi_value value) {
  if (consume_fault(claim, ATOMIC_FAULT_AUDIT_PROPERTY)) {
    return napi_generic_failure;
  }
  return napi_set_named_property(env, audit, name, value);
}

static napi_status atomic_create_audit_reference(atomic_claim *claim,
                                                 napi_env env,
                                                 napi_value audit,
                                                 napi_ref *reference) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT ==
      ATOMIC_FAULT_PREAUTHORITY_DEFERRED_SETTLE) {
    return napi_generic_failure;
  }
  if (consume_fault(claim, ATOMIC_FAULT_AUDIT_REFERENCE)) {
    return napi_generic_failure;
  }
  return napi_create_reference(env, audit, 1, reference);
}

static napi_status atomic_create_external(napi_env env, atomic_claim *claim,
                                          napi_finalize finalizer,
                                          napi_value *external) {
  if (consume_fault(claim, ATOMIC_FAULT_CLAIM_EXTERNAL)) {
    return napi_generic_failure;
  }
  return napi_create_external(env, claim, finalizer, NULL, external);
}

static napi_status atomic_create_owner_reference(atomic_claim *claim,
                                                 napi_env env,
                                                 napi_value external,
                                                 napi_ref *reference) {
  if (consume_fault(claim, ATOMIC_FAULT_CLAIM_REFERENCE)) {
    return napi_generic_failure;
  }
  return napi_create_reference(env, external, 1, reference);
}

static int atomic_timer_init(atomic_claim *claim, uv_loop_t *loop,
                             uv_timer_t *timer) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT ==
          ATOMIC_FAULT_PREAUTHORITY_REF_DELETE ||
      consume_fault(claim, ATOMIC_FAULT_CLAIM_TIMER_INIT)) {
    return UV_ENOMEM;
  }
  return uv_timer_init(loop, timer);
}

static int atomic_timer_start(atomic_claim *claim, uv_timer_t *timer,
                              uv_timer_cb callback, uint64_t timeout,
                              uint64_t repeat) {
  if (consume_fault(claim, ATOMIC_FAULT_CLAIM_TIMER_START)) {
    return UV_EINVAL;
  }
  return uv_timer_start(timer, callback, timeout, repeat);
}

static int atomic_settlement_timer_init(atomic_claim *claim, uv_loop_t *loop) {
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_OWNER_INIT)) {
    return UV_ENOMEM;
  }
  return uv_timer_init(loop, &claim->settlement_timer);
}

static int atomic_settlement_timer_start(atomic_claim *claim) {
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_OWNER_START)) {
    return UV_EINVAL;
  }
  return uv_timer_start(&claim->settlement_timer, settlement_owner_poll, 10, 10);
}

static int atomic_settlement_timer_ref(atomic_claim *claim) {
  uv_ref((uv_handle_t *)&claim->settlement_timer);
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_OWNER_REF)) {
    uv_unref((uv_handle_t *)&claim->settlement_timer);
    return 0;
  }
  return uv_has_ref((uv_handle_t *)&claim->settlement_timer);
}

static napi_status atomic_create_reference(atomic_claim *claim, napi_env env,
                                           napi_value value, uint32_t initial,
                                           napi_ref *reference) {
  if (consume_fault(claim, ATOMIC_FAULT_NAPI_REFERENCE)) {
    return napi_generic_failure;
  }
  return napi_create_reference(env, value, initial, reference);
}

static napi_status atomic_create_async_work(
    atomic_claim *claim, napi_env env, napi_value resource, napi_value name,
    napi_async_execute_callback execute, napi_async_complete_callback complete,
    void *data, napi_async_work *work) {
  if (consume_fault(claim, ATOMIC_FAULT_NAPI_ASYNC_CREATE)) {
    return napi_generic_failure;
  }
  return napi_create_async_work(env, resource, name, execute, complete, data,
                                work);
}

static napi_status atomic_queue_async_work(atomic_claim *claim, napi_env env,
                                           napi_async_work work) {
  if (consume_fault(claim, ATOMIC_FAULT_NAPI_ASYNC_QUEUE)) {
    return napi_generic_failure;
  }
  return napi_queue_async_work(env, work);
}

static napi_status atomic_open_settlement_scope(atomic_claim *claim,
                                                napi_env env,
                                                napi_handle_scope *scope) {
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_HANDLE_SCOPE)) {
    return napi_generic_failure;
  }
  return napi_open_handle_scope(env, scope);
}

static napi_status atomic_create_settlement_object(atomic_claim *claim,
                                                   napi_env env,
                                                   napi_value *object) {
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_OBJECT)) {
    return napi_generic_failure;
  }
  return napi_create_object(env, object);
}

static napi_status atomic_set_settlement_property(atomic_claim *claim,
                                                  napi_env env,
                                                  napi_value object,
                                                  const char *name,
                                                  napi_value value) {
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_PROPERTY)) {
    return napi_generic_failure;
  }
  return napi_set_named_property(env, object, name, value);
}

static napi_status atomic_resolve_settlement(atomic_claim *claim, napi_env env,
                                             napi_deferred deferred,
                                             napi_value value) {
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_RESOLVE)) {
    return napi_generic_failure;
  }
  return napi_resolve_deferred(env, deferred, value);
}

static napi_status atomic_reject_settlement(atomic_claim *claim, napi_env env,
                                            napi_deferred deferred,
                                            napi_value value) {
  if (consume_fault(claim, ATOMIC_FAULT_SETTLEMENT_REJECT)) {
    return napi_generic_failure;
  }
  return napi_reject_deferred(env, deferred, value);
}

static int consume_lifecycle_fault(atomic_claim *claim, int variant) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT != variant) return 0;
  return __atomic_exchange_n(&claim->lifecycle_fault_consumed, 1,
                             __ATOMIC_ACQ_REL) == 0;
}

static napi_status atomic_open_lifecycle_scope(atomic_claim *claim,
                                               napi_handle_scope *scope) {
  if (consume_lifecycle_fault(claim,
                              ATOMIC_FAULT_SETTLEMENT_HANDLE_SCOPE)) {
    claim->lifecycle_handle_scope_failures++;
    return napi_generic_failure;
  }
  return napi_open_handle_scope(claim->env, scope);
}

static napi_status atomic_create_lifecycle_object(atomic_claim *claim,
                                                  napi_value *object) {
  if (consume_lifecycle_fault(claim, ATOMIC_FAULT_SETTLEMENT_OBJECT)) {
    claim->lifecycle_object_failures++;
    return napi_generic_failure;
  }
  return napi_create_object(claim->env, object);
}

static napi_status atomic_set_lifecycle_property(atomic_claim *claim,
                                                 napi_value object,
                                                 const char *name,
                                                 napi_value value) {
  if (consume_lifecycle_fault(claim, ATOMIC_FAULT_SETTLEMENT_PROPERTY)) {
    claim->lifecycle_property_failures++;
    return napi_generic_failure;
  }
  return napi_set_named_property(claim->env, object, name, value);
}

static napi_status atomic_freeze_lifecycle(atomic_claim *claim,
                                           napi_value object) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT == ATOMIC_FAULT_SETTLEMENT_OBJECT &&
      __atomic_exchange_n(&claim->lifecycle_freeze_fault_consumed, 1,
                          __ATOMIC_ACQ_REL) == 0) {
    claim->lifecycle_freeze_failures++;
    return napi_generic_failure;
  }
  return napi_object_freeze(claim->env, object);
}

static napi_status atomic_resolve_lifecycle(atomic_claim *claim,
                                            napi_value value) {
  if (consume_lifecycle_fault(claim, ATOMIC_FAULT_SETTLEMENT_RESOLVE)) {
    claim->lifecycle_resolve_failures++;
    return napi_generic_failure;
  }
  return napi_resolve_deferred(claim->env, claim->lifecycle_deferred, value);
}

static napi_status atomic_delete_lifecycle_audit_ref(atomic_claim *claim) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT == ATOMIC_FAULT_SETTLEMENT_PROPERTY &&
      __atomic_exchange_n(&claim->lifecycle_ref_delete_fault_consumed, 1,
                          __ATOMIC_ACQ_REL) == 0) {
    claim->lifecycle_ref_delete_failures++;
    return napi_generic_failure;
  }
  return napi_delete_reference(claim->env, claim->audit_ref);
}

static int arm_lifecycle_scope_close_fault(atomic_claim *claim) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT !=
      ATOMIC_FAULT_LIFECYCLE_SCOPE_CLOSE) {
    return 0;
  }
  if (__atomic_exchange_n(&claim->lifecycle_scope_close_fault_consumed, 1,
                          __ATOMIC_ACQ_REL) != 0) {
    return 0;
  }
  claim->lifecycle_handle_scope_close_failures++;
  return 1;
}

static napi_status atomic_close_lifecycle_scope(
    atomic_claim *claim, napi_handle_scope scope, int inject_failure) {
  napi_status status = napi_close_handle_scope(claim->env, scope);
  if (status == napi_ok && inject_failure) {
    return napi_generic_failure;
  }
  return status;
}

static pid_t atomic_waitpid(atomic_claim *claim, int *status, int options) {
  __atomic_add_fetch(&claim->wait_attempts, 1U, __ATOMIC_RELAXED);
  if (ATOMIC_PUBLISH_FAULT_VARIANT == ATOMIC_FAULT_POST_KILL_TIMEOUT &&
      __atomic_load_n(&claim->post_kill_barrier_state, __ATOMIC_ACQUIRE) == 1) {
    return 0;
  }
  if (consume_fault(claim, ATOMIC_FAULT_WAIT)) {
    errno = EIO;
    return -1;
  }
  return waitpid(claim->pid, status, options);
}

static int atomic_clock_gettime(atomic_claim *claim, clockid_t clock,
                                struct timespec *time) {
  __atomic_add_fetch(&claim->deadline_attempts, 1U, __ATOMIC_RELAXED);
  if (consume_fault(claim, ATOMIC_FAULT_DEADLINE)) {
    errno = EIO;
    return -1;
  }
  return clock_gettime(clock, time);
}

static int atomic_pidfd_send_signal(atomic_claim *claim, int signal_number) {
#ifdef SYS_pidfd_send_signal
  if (signal_number != 0) {
    __atomic_add_fetch(&claim->signal_attempts, 1U, __ATOMIC_RELAXED);
    if (signal_number == SIGTERM) {
      __atomic_add_fetch(&claim->term_signal_attempts, 1U, __ATOMIC_RELAXED);
    } else if (signal_number == SIGKILL) {
      __atomic_add_fetch(&claim->kill_signal_attempts, 1U, __ATOMIC_RELAXED);
    }
  }
  if (signal_number != 0 &&
      consume_fault(claim, ATOMIC_FAULT_PIDFD_SIGNAL)) {
    errno = EIO;
    return -1;
  }
  int result = (int)syscall(SYS_pidfd_send_signal, claim->pidfd, signal_number,
                            NULL, 0);
  if (result == 0 && signal_number == SIGKILL &&
      ATOMIC_PUBLISH_FAULT_VARIANT == ATOMIC_FAULT_POST_KILL_TIMEOUT) {
    int expected = 0;
    __atomic_compare_exchange_n(&claim->post_kill_barrier_state, &expected, 1,
                                false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
  }
  return result;
#else
  (void)claim;
  (void)signal_number;
  errno = ENOSYS;
  return -1;
#endif
}

static const char atomic_claim_owner;
static atomic_claim *active_claims;
static int inherited_lock_prepared;

static void cleanup_owner_poll(uv_timer_t *timer);
static void cleanup_owner_closed(uv_handle_t *handle);
static void settlement_owner_poll(uv_timer_t *timer);
static void settlement_owner_closed(uv_handle_t *handle);
static void close_cleanup_owner(atomic_claim *claim);
static void close_settlement_owner(atomic_claim *claim);
static int settle_lifecycle_completion(atomic_claim *claim);
static int close_claim_pidfd(atomic_claim *claim);
static void retain_failure(atomic_claim *claim, const char *category,
                           int error_number);
static void set_cleanup_owner_state(atomic_claim *claim, int cleanup_mode);

static int authenticate_fixture_control(void) {
  struct stat status;
  int descriptor_flags;
  int open_flags;
  char expected[64];
  char actual[64];
  int expected_length =
      snprintf(expected, sizeof(expected),
               "atomic-orphan-fixture-control-v1:%02d\n",
               ATOMIC_PUBLISH_FAULT_VARIANT);
  if (expected_length <= 0 || (size_t)expected_length >= sizeof(expected) ||
      fstat(6, &status) != 0 || !S_ISREG(status.st_mode) ||
      status.st_uid != getuid() || (status.st_mode & 07777) != 0600 ||
      status.st_nlink != 0 ||
      (descriptor_flags = fcntl(6, F_GETFD)) < 0 ||
      (descriptor_flags & FD_CLOEXEC) == 0 ||
      (open_flags = fcntl(6, F_GETFL)) < 0 ||
      (open_flags & O_ACCMODE) != O_RDONLY) {
    return 0;
  }
  ssize_t count;
  do {
    count = pread(6, actual, (size_t)expected_length + 1U, 0);
  } while (count < 0 && errno == EINTR);
  return count == expected_length &&
         memcmp(actual, expected, (size_t)expected_length) == 0;
}

void atomic_publish_test_hook_before(void) {}
void atomic_publish_test_hook_after(void) {}

static napi_value throw_test(napi_env env, const char *message) {
  if (napi_throw_error(env, "atomic_publish_test_hook_invalid", message) !=
      napi_ok) {
    return NULL;
  }
  return NULL;
}

static void setup_audit_state_finalizer(napi_env env, void *data, void *hint) {
  (void)env;
  (void)data;
  setup_audit_state *state = hint;
  if (__atomic_sub_fetch(&state->references, 1U, __ATOMIC_ACQ_REL) == 0) {
    free(state);
  }
}

static void release_setup_audit_claim_owner(atomic_claim *claim) {
  setup_audit_state *state = claim->setup_audit_state;
  if (state == NULL) {
    return;
  }
  claim->setup_audit_state = NULL;
  if (__atomic_sub_fetch(&state->references, 1U, __ATOMIC_ACQ_REL) == 0) {
    free(state);
  }
}

static void maybe_complete_claim_setup(atomic_claim *claim) {
  setup_audit_state *state = claim->setup_audit_state;
  if (!claim->setup_failure_pending || state == NULL ||
      claim->promise_ref != NULL || claim->audit_ref != NULL ||
      claim->handle_ref != NULL || claim->setup_result_ref != NULL ||
      claim->deferred != NULL || claim->cleanup_deferred != NULL ||
      claim->lifecycle_deferred != NULL || claim->setup_deferred != NULL ||
      claim->pidfd >= 0 ||
      (claim->cleanup_timer_initialized && !claim->cleanup_timer_closed) ||
      (claim->settlement_timer_initialized && !claim->settlement_timer_closed)) {
    return;
  }
  state->counters[SETUP_AUDIT_EXTERNAL_CREATE_REQUESTS] =
      claim->external_create_requests;
  state->counters[SETUP_AUDIT_EXTERNAL_CREATE_COMPLETIONS] =
      claim->external_create_completions;
  state->counters[SETUP_AUDIT_OWNER_REF_CREATE_REQUESTS] =
      claim->owner_ref_create_requests;
  state->counters[SETUP_AUDIT_OWNER_REF_CREATE_COMPLETIONS] =
      claim->owner_ref_create_completions;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_INIT_REQUESTS] =
      claim->settlement_owner_init_requests;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_INIT_COMPLETIONS] =
      claim->settlement_owner_init_completions;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_INIT_FAILURES] =
      claim->settlement_owner_init_failures;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_START_REQUESTS] =
      claim->settlement_owner_start_requests;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_START_COMPLETIONS] =
      claim->settlement_owner_start_completions;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_START_FAILURES] =
      claim->settlement_owner_start_failures;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_REF_REQUESTS] =
      claim->settlement_owner_ref_requests;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_REF_COMPLETIONS] =
      claim->settlement_owner_ref_completions;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_REF_FAILURES] =
      claim->settlement_owner_ref_failures;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_CLOSE_REQUESTS] =
      claim->settlement_owner_close_requests;
  state->counters[SETUP_AUDIT_SETTLEMENT_OWNER_CLOSE_COMPLETIONS] =
      claim->settlement_owner_close_completions;
  state->counters[SETUP_AUDIT_PREAUTHORITY_REF_DELETE_REQUESTS] =
      claim->preauthority_ref_delete_attempts;
  state->counters[SETUP_AUDIT_PREAUTHORITY_REF_DELETE_FAILURES] =
      claim->preauthority_ref_delete_failures;
  state->counters[SETUP_AUDIT_PREAUTHORITY_REF_DELETE_COMPLETIONS] =
      claim->preauthority_ref_delete_completions;
  state->counters[SETUP_AUDIT_PREAUTHORITY_REF_DELETE_RETRIES] =
      claim->preauthority_ref_delete_retries;
  state->counters[SETUP_AUDIT_DEFERRED_SETTLE_REQUESTS] =
      claim->preauthority_deferred_settle_requests;
  state->counters[SETUP_AUDIT_DEFERRED_SETTLE_FAILURES] =
      claim->preauthority_deferred_settle_failures;
  state->counters[SETUP_AUDIT_DEFERRED_SETTLE_COMPLETIONS] =
      claim->preauthority_deferred_settle_completions;
  state->counters[SETUP_AUDIT_SETUP_SETTLE_REQUESTS] =
      claim->setup_deferred_settle_requests;
  state->counters[SETUP_AUDIT_SETUP_SETTLE_FAILURES] =
      claim->setup_deferred_settle_failures;
  state->counters[SETUP_AUDIT_SETUP_SETTLE_COMPLETIONS] =
      claim->setup_deferred_settle_completions;
  state->counters[SETUP_AUDIT_SETUP_RESULT_REF_DELETE_REQUESTS] =
      claim->setup_result_ref_delete_requests;
  state->counters[SETUP_AUDIT_SETUP_RESULT_REF_DELETE_FAILURES] =
      claim->setup_result_ref_delete_failures;
  state->counters[SETUP_AUDIT_SETUP_RESULT_REF_DELETE_COMPLETIONS] =
      claim->setup_result_ref_delete_completions;
  state->counters[SETUP_AUDIT_MANDATORY_DEFERREDS_CREATED] =
      claim->mandatory_deferreds_created;
  state->counters[SETUP_AUDIT_MANDATORY_DEFERREDS_SETTLED] =
      claim->mandatory_deferreds_settled;
  state->counters[SETUP_AUDIT_PREAUTHORITY_SETTLEMENT_RETRIES] =
      claim->preauthority_settlement_retries;
  __atomic_store_n(&state->counters[SETUP_AUDIT_TERMINAL], 1U,
                   __ATOMIC_RELEASE);
  release_setup_audit_claim_owner(claim);
}

static napi_value throw_claim_setup(atomic_claim *claim, const char *message) {
  napi_value message_value;
  napi_value error;
  napi_value setup_completion;
  napi_value setup_result;
  napi_value setup_arraybuffer;
  napi_value setup_counters;
  int owner_live =
      claim->settlement_timer_initialized &&
      !claim->settlement_timer_close_requested &&
      uv_is_active((uv_handle_t *)&claim->settlement_timer) &&
      uv_has_ref((uv_handle_t *)&claim->settlement_timer);
  if (!owner_live) {
    return throw_test(claim->env, message);
  }
  setup_audit_state *state = calloc(1, sizeof(*state));
  if (state == NULL) {
    return throw_test(claim->env, message);
  }
  state->references = 1;
  claim->setup_audit_state = state;
  claim->setup_failure_pending = 1;
  claim->preauthority_cleanup = 1;
  __atomic_add_fetch(&state->references, 1U, __ATOMIC_RELAXED);
  if (napi_create_external_arraybuffer(
          claim->env, state->counters, sizeof(state->counters),
          setup_audit_state_finalizer, state, &setup_arraybuffer) != napi_ok) {
    __atomic_sub_fetch(&state->references, 1U, __ATOMIC_ACQ_REL);
    release_setup_audit_claim_owner(claim);
    return throw_test(claim->env, message);
  }
  if (napi_create_typedarray(claim->env, napi_uint32_array, 32,
                             setup_arraybuffer, 0, &setup_counters) != napi_ok ||
      napi_create_object(claim->env, &setup_result) != napi_ok ||
      napi_set_named_property(claim->env, setup_result, "counters",
                              setup_counters) != napi_ok ||
      napi_object_freeze(claim->env, setup_result) != napi_ok ||
      napi_create_reference(claim->env, setup_result, 1,
                            &claim->setup_result_ref) != napi_ok ||
      napi_create_promise(claim->env, &claim->setup_deferred,
                          &setup_completion) != napi_ok ||
      napi_create_string_utf8(claim->env, message, NAPI_AUTO_LENGTH,
                              &message_value) != napi_ok ||
      napi_create_error(claim->env, NULL, message_value, &error) != napi_ok ||
      napi_set_named_property(claim->env, error, "setupCompletion",
                              setup_completion) != napi_ok) {
    return throw_test(claim->env, message);
  }
  claim->setup_deferred_settle_requests++;
  napi_status resolve_status =
      consume_fault(claim, ATOMIC_FAULT_SETUP_RESOLVE)
          ? napi_generic_failure
          : napi_resolve_deferred(claim->env, claim->setup_deferred,
                                  setup_result);
  if (resolve_status == napi_ok) {
    claim->setup_deferred = NULL;
    claim->setup_deferred_settle_completions++;
  } else {
    claim->setup_deferred_settle_failures++;
  }
  if (napi_throw(claim->env, error) != napi_ok) {
    return NULL;
  }
  return NULL;
}

static int exact_keys(napi_env env, napi_value value, const char **keys,
                      size_t count) {
  napi_value names;
  uint32_t length;
  if (napi_get_all_property_names(
          env, value, napi_key_own_only, napi_key_all_properties,
          napi_key_keep_numbers, &names) != napi_ok ||
      napi_get_array_length(env, names, &length) != napi_ok ||
      length != count) {
    return 0;
  }
  for (uint32_t index = 0; index < length; index++) {
    napi_value key;
    napi_valuetype type;
    char actual[128];
    size_t actual_length;
    size_t copied;
    int matched = 0;
    if (napi_get_element(env, names, index, &key) != napi_ok ||
        napi_typeof(env, key, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, key, NULL, 0, &actual_length) !=
            napi_ok ||
        actual_length == 0 || actual_length >= sizeof(actual) ||
        napi_get_value_string_utf8(env, key, actual, sizeof(actual), &copied) !=
            napi_ok ||
        copied != actual_length ||
        memchr(actual, '\0', actual_length) != NULL) {
      return 0;
    }
    for (size_t expected = 0; expected < count; expected++) {
      if (strlen(keys[expected]) == actual_length &&
          memcmp(keys[expected], actual, actual_length) == 0) {
        matched++;
      }
    }
    if (matched != 1) return 0;
  }
  return 1;
}

static int read_int32_property(napi_env env, napi_value object,
                               const char *name, int32_t *result) {
  napi_value value;
  napi_valuetype type;
  double number;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || floor(number) != number || number < 1.0 ||
      number > (double)INT32_MAX ||
      napi_get_value_int32(env, value, result) != napi_ok ||
      (double)*result != number) {
    return 0;
  }
  return 1;
}

static int read_uint32_property(napi_env env, napi_value object,
                                const char *name, uint32_t *result) {
  napi_value value;
  napi_valuetype type;
  double number;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || floor(number) != number || number < 0.0 ||
      number > (double)UINT32_MAX ||
      napi_get_value_uint32(env, value, result) != napi_ok ||
      (double)*result != number) {
    return 0;
  }
  return 1;
}

static int read_string_property(napi_env env, napi_value object,
                                const char *name, char *buffer,
                                size_t capacity) {
  napi_value value;
  napi_valuetype type;
  size_t length;
  size_t copied;
  if (napi_get_named_property(env, object, name, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length >= capacity ||
      napi_get_value_string_utf8(env, value, buffer, capacity, &copied) !=
          napi_ok ||
      copied != length || memchr(buffer, '\0', length) != NULL ||
      buffer[length] != '\0') {
    return 0;
  }
  return 1;
}

static int proc_stat(pid_t pid, pid_t *parent, char *starttime,
                     size_t starttime_capacity) {
  char path[64];
  char bytes[4096];
  snprintf(path, sizeof(path), "/proc/%ld/stat", (long)pid);
  FILE *stream = fopen(path, "re");
  if (stream == NULL) {
    return 0;
  }
  size_t length = fread(bytes, 1, sizeof(bytes) - 1, stream);
  int saved = errno;
  fclose(stream);
  errno = saved;
  if (length == 0 || length == sizeof(bytes) - 1) {
    return 0;
  }
  bytes[length] = '\0';
  char *tail = strrchr(bytes, ')');
  if (tail == NULL || tail[1] != ' ') {
    return 0;
  }
  char state;
  long parent_long;
  unsigned long long ignored;
  unsigned long long start;
  int matched = sscanf(
      tail + 2,
      "%c %ld %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu %llu "
      "%llu %llu %llu %llu %llu %llu %llu",
      &state, &parent_long, &ignored, &ignored, &ignored, &ignored, &ignored,
      &ignored, &ignored, &ignored, &ignored, &ignored, &ignored, &ignored,
      &ignored, &ignored, &ignored, &ignored, &ignored, &start);
  if (matched != 20 || parent_long <= 0) {
    return 0;
  }
  *parent = (pid_t)parent_long;
  int written =
      snprintf(starttime, starttime_capacity, "%llu", (unsigned long long)start);
  return written > 0 && (size_t)written < starttime_capacity;
}

static int read_bounded_file(const char *path, unsigned char *bytes,
                             size_t capacity, size_t *length) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    return 0;
  }
  size_t used = 0;
  while (used < capacity) {
    ssize_t count = read(fd, bytes + used, capacity - used);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count < 0) {
      close(fd);
      return 0;
    }
    if (count == 0) {
      *length = used;
      close(fd);
      return 1;
    }
    used += (size_t)count;
  }
  unsigned char extra;
  ssize_t count = read(fd, &extra, 1);
  close(fd);
  return count == 0 ? (*length = used, 1) : 0;
}

static int sha256_file(const char *path, char output[65]) {
  int input = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (input < 0) {
    return 0;
  }
  int algorithm = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
  if (algorithm < 0) {
    close(input);
    return 0;
  }
  struct sockaddr_alg address;
  memset(&address, 0, sizeof(address));
  address.salg_family = AF_ALG;
  memcpy(address.salg_type, "hash", 5);
  memcpy(address.salg_name, "sha256", 7);
  if (bind(algorithm, (struct sockaddr *)&address, sizeof(address)) != 0) {
    close(algorithm);
    close(input);
    return 0;
  }
  int operation = accept4(algorithm, NULL, NULL, SOCK_CLOEXEC);
  close(algorithm);
  if (operation < 0) {
    close(input);
    return 0;
  }
  unsigned char buffer[16384];
  for (;;) {
    ssize_t count = read(input, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count < 0) {
      close(operation);
      close(input);
      return 0;
    }
    if (count == 0) {
      break;
    }
    size_t sent = 0;
    while (sent < (size_t)count) {
      ssize_t written =
          send(operation, buffer + sent, (size_t)count - sent, MSG_MORE);
      if (written < 0 && errno == EINTR) {
        continue;
      }
      if (written <= 0) {
        close(operation);
        close(input);
        return 0;
      }
      sent += (size_t)written;
    }
  }
  close(input);
  if (send(operation, NULL, 0, 0) != 0) {
    close(operation);
    return 0;
  }
  unsigned char digest[32];
  size_t received = 0;
  while (received < sizeof(digest)) {
    ssize_t count = read(operation, digest + received, sizeof(digest) - received);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    if (count <= 0) {
      close(operation);
      return 0;
    }
    received += (size_t)count;
  }
  close(operation);
  static const char hex[] = "0123456789abcdef";
  for (size_t index = 0; index < sizeof(digest); index++) {
    output[index * 2] = hex[digest[index] >> 4];
    output[index * 2 + 1] = hex[digest[index] & 15];
  }
  output[64] = '\0';
  return 1;
}

static int exact_environment(pid_t pid) {
  char path[64];
  unsigned char bytes[4096];
  size_t length;
  snprintf(path, sizeof(path), "/proc/%ld/environ", (long)pid);
  if (!read_bounded_file(path, bytes, sizeof(bytes), &length) || length == 0 ||
      bytes[length - 1] != '\0') {
    return 0;
  }
  const char *expected[] = {
      "PATH=/usr/bin:/bin",
      "LC_ALL=C",
      "LANG=C",
      "TZ=UTC",
      "ATOMIC_BUILD_LOCK_FD=9",
      "ATOMIC_BUILD_LOCK_FIXTURE_ROLE=descendant",
  };
  bool found[sizeof(expected) / sizeof(expected[0])];
  bool dynamic_found[3] = {false, false, false};
  memset(found, 0, sizeof(found));
  size_t offset = 0;
  size_t count = 0;
  while (offset < length) {
    size_t item_length = strlen((char *)bytes + offset);
    if (item_length == 0 || offset + item_length >= length) {
      return 0;
    }
    bool matched = false;
    const char *item = (char *)bytes + offset;
    const char *driver_prefix = "ATOMIC_BUILD_LOCK_FIXTURE_DRIVER_PID=";
    const char *parent_prefix =
        "ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID=";
    const char *parent_start_prefix =
        "ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME=";
    const char *dynamic_prefix = NULL;
    size_t dynamic_index = 0;
    if (strncmp(item, driver_prefix, strlen(driver_prefix)) == 0) {
      dynamic_prefix = driver_prefix;
      dynamic_index = 0;
    } else if (strncmp(item, parent_prefix, strlen(parent_prefix)) == 0) {
      dynamic_prefix = parent_prefix;
      dynamic_index = 1;
    } else if (strncmp(item, parent_start_prefix,
                       strlen(parent_start_prefix)) == 0) {
      dynamic_prefix = parent_start_prefix;
      dynamic_index = 2;
    }
    if (dynamic_prefix != NULL) {
      if (dynamic_found[dynamic_index]) {
        return 0;
      }
      const char *digits = item + strlen(dynamic_prefix);
      matched = *digits >= '1' && *digits <= '9';
      for (const char *cursor = digits; matched && *cursor != '\0'; cursor++) {
        matched = *cursor >= '0' && *cursor <= '9';
      }
      if (matched) {
        dynamic_found[dynamic_index] = true;
        count++;
        offset += item_length + 1;
        continue;
      }
    }
    for (size_t index = 0; index < sizeof(expected) / sizeof(expected[0]);
         index++) {
      if (!found[index] && strcmp((char *)bytes + offset, expected[index]) == 0) {
        found[index] = true;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return 0;
    }
    count++;
    offset += item_length + 1;
  }
  return count == sizeof(expected) / sizeof(expected[0]) + 3 &&
         dynamic_found[0] && dynamic_found[1] && dynamic_found[2];
}

static int exact_cmdline(pid_t pid, const char *node, const char *script) {
  char path[64];
  unsigned char bytes[4096];
  size_t length;
  snprintf(path, sizeof(path), "/proc/%ld/cmdline", (long)pid);
  if (!read_bounded_file(path, bytes, sizeof(bytes), &length)) {
    return 0;
  }
  size_t node_length = strlen(node);
  size_t script_length = strlen(script);
  return length == node_length + script_length + 2 &&
         memcmp(bytes, node, node_length) == 0 && bytes[node_length] == '\0' &&
         memcmp(bytes + node_length + 1, script, script_length) == 0 &&
         bytes[length - 1] == '\0';
}

static int exact_prepare_environment(const char *role, pid_t expected_parent,
                                     const char *expected_parent_starttime) {
  unsigned char bytes[4096];
  size_t length;
  if (!read_bounded_file("/proc/self/environ", bytes, sizeof(bytes), &length) ||
      length == 0 || bytes[length - 1] != '\0') {
    return 0;
  }
  char role_entry[96];
  char parent_entry[96];
  char parent_start_entry[160];
  char driver_entry[96];
  const char *environment_role = NULL;
  if (strcmp(role, "orphan_lock_driver_v1") == 0) {
    environment_role = "driver";
  } else if (strcmp(role, "orphan_lock_descendant_v1") == 0) {
    environment_role = "descendant";
  } else {
    return 0;
  }
  snprintf(role_entry, sizeof(role_entry),
           "ATOMIC_BUILD_LOCK_FIXTURE_ROLE=%s", environment_role);
  snprintf(parent_entry, sizeof(parent_entry),
           "ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_PID=%ld",
           (long)expected_parent);
  snprintf(parent_start_entry, sizeof(parent_start_entry),
           "ATOMIC_BUILD_LOCK_FIXTURE_EXPECTED_PARENT_STARTTIME=%s",
           expected_parent_starttime);
  const int descendant =
      strcmp(role, "orphan_lock_descendant_v1") == 0;
  if (descendant) {
    snprintf(driver_entry, sizeof(driver_entry),
             "ATOMIC_BUILD_LOCK_FIXTURE_DRIVER_PID=%ld",
             (long)expected_parent);
  }
  const char *expected[] = {
      "PATH=/usr/bin:/bin",
      "LC_ALL=C",
      "LANG=C",
      "TZ=UTC",
      "ATOMIC_BUILD_LOCK_FD=9",
      role_entry,
      parent_entry,
      parent_start_entry,
      driver_entry,
  };
  const size_t expected_count = descendant ? 9U : 8U;
  bool found[9] = {false};
  size_t offset = 0;
  size_t count = 0;
  while (offset < length) {
    size_t item_length = strlen((char *)bytes + offset);
    if (item_length == 0 || offset + item_length >= length) {
      return 0;
    }
    bool matched = false;
    for (size_t index = 0; index < expected_count; index++) {
      if (!found[index] &&
          strcmp((char *)bytes + offset, expected[index]) == 0) {
        found[index] = true;
        matched = true;
        break;
      }
    }
    if (!matched) {
      return 0;
    }
    count++;
    offset += item_length + 1;
  }
  return count == expected_count;
}

static int parse_procfd_flags(pid_t pid, int *open_flags) {
  char path[64];
  unsigned char bytes[1024];
  size_t length;
  snprintf(path, sizeof(path), "/proc/%ld/fdinfo/9", (long)pid);
  if (!read_bounded_file(path, bytes, sizeof(bytes) - 1, &length)) {
    return 0;
  }
  bytes[length] = '\0';
  char *flags = strstr((char *)bytes, "flags:");
  unsigned long value;
  if (flags == NULL || sscanf(flags, "flags:\t%lo", &value) != 1 ||
      value > INT32_MAX) {
    return 0;
  }
  *open_flags = (int)value;
  return 1;
}

static int authenticate_private_lock(const struct stat *descriptor_status) {
  char target[4096];
  ssize_t length = readlink("/proc/self/fd/9", target, sizeof(target) - 1);
  if (length <= 0 || (size_t)length >= sizeof(target) - 1) {
    return 0;
  }
  target[length] = '\0';
  const char suffix[] = "/.atomic-directory-publication-build.lock";
  size_t target_length = (size_t)length;
  size_t suffix_length = sizeof(suffix) - 1;
  if (target_length <= suffix_length ||
      strcmp(target + target_length - suffix_length, suffix) != 0) {
    return 0;
  }
  struct stat path_status;
  if (lstat(target, &path_status) != 0 || !S_ISREG(path_status.st_mode) ||
      path_status.st_dev != descriptor_status->st_dev ||
      path_status.st_ino != descriptor_status->st_ino) {
    return 0;
  }
  target[target_length - suffix_length] = '\0';
  struct stat parent_status;
  return lstat(target, &parent_status) == 0 &&
         S_ISDIR(parent_status.st_mode) &&
         parent_status.st_uid == getuid() &&
         (parent_status.st_mode & 07777) == 0700 &&
         parent_status.st_nlink >= 2;
}

static int validate_fd9(pid_t pid, const char *expected_device,
                        const char *expected_inode, uid_t expected_uid,
                        mode_t expected_mode, nlink_t expected_nlink) {
  char path[64];
  struct stat status;
  snprintf(path, sizeof(path), "/proc/%ld/fd/9", (long)pid);
  if (stat(path, &status) != 0 || !S_ISREG(status.st_mode) ||
      status.st_uid != expected_uid ||
      (status.st_mode & 07777) != expected_mode ||
      status.st_nlink != expected_nlink) {
    return 0;
  }
  char device[64];
  char inode[64];
  snprintf(device, sizeof(device), "%llu",
           (unsigned long long)status.st_dev);
  snprintf(inode, sizeof(inode), "%llu",
           (unsigned long long)status.st_ino);
  if (strcmp(device, expected_device) != 0 ||
      strcmp(inode, expected_inode) != 0) {
    return 0;
  }
  unsigned char bytes[1024];
  size_t length;
  snprintf(path, sizeof(path), "/proc/%ld/fdinfo/9", (long)pid);
  if (!read_bounded_file(path, bytes, sizeof(bytes) - 1, &length)) {
    return 0;
  }
  bytes[length] = '\0';
  char *flags = strstr((char *)bytes, "flags:");
  if (flags == NULL) {
    return 0;
  }
  unsigned long value;
  if (sscanf(flags, "flags:\t%lo", &value) != 1) {
    return 0;
  }
  return (value & O_CLOEXEC) == 0;
}

static int validate_identity(
    pid_t pid, const char *starttime, const char *node_path,
    const char *node_hash, const char *script_path, const char *script_hash,
    const char *fd9_device, const char *fd9_inode, uid_t fd9_uid,
    mode_t fd9_mode, nlink_t fd9_nlink,
    const char *adoptive_parent_starttime) {
  pid_t observed_parent;
  char observed_starttime[64];
  char parent_starttime[64];
  pid_t parent_parent;
  char proc_path[64];
  char executable[4096];
  char canonical_node[4096];
  char canonical_script[4096];
  char observed_node_hash[65];
  char observed_script_hash[65];
  snprintf(proc_path, sizeof(proc_path), "/proc/%ld/exe", (long)pid);
  ssize_t executable_length =
      readlink(proc_path, executable, sizeof(executable) - 1);
  if (executable_length <= 0 ||
      (size_t)executable_length >= sizeof(executable) - 1) {
    return 0;
  }
  executable[executable_length] = '\0';
  if (realpath(node_path, canonical_node) == NULL ||
      strcmp(canonical_node, node_path) != 0 ||
      realpath(script_path, canonical_script) == NULL ||
      strcmp(canonical_script, script_path) != 0 ||
      strcmp(executable, canonical_node) != 0 ||
      !sha256_file(canonical_node, observed_node_hash) ||
      !sha256_file(canonical_script, observed_script_hash) ||
      strcmp(observed_node_hash, node_hash) != 0 ||
      strcmp(observed_script_hash, script_hash) != 0 ||
      !proc_stat(pid, &observed_parent, observed_starttime,
                 sizeof(observed_starttime)) ||
      observed_parent != getpid() || strcmp(observed_starttime, starttime) != 0 ||
      !proc_stat(getpid(), &parent_parent, parent_starttime,
                 sizeof(parent_starttime)) ||
      strcmp(parent_starttime, adoptive_parent_starttime) != 0 ||
      !exact_cmdline(pid, canonical_node, canonical_script) ||
      !exact_environment(pid) ||
      !validate_fd9(pid, fd9_device, fd9_inode, fd9_uid, fd9_mode,
                    fd9_nlink)) {
    return 0;
  }
  return 1;
}

static int preauthority_claim_can_free(const atomic_claim *claim) {
  return !claim->published && claim->pidfd < 0 &&
         (!claim->cleanup_timer_initialized || claim->cleanup_timer_closed) &&
         (!claim->settlement_timer_initialized ||
          claim->settlement_timer_closed) &&
         claim->work == NULL && claim->promise_ref == NULL &&
         claim->audit_ref == NULL && claim->handle_ref == NULL &&
         claim->setup_result_ref == NULL && claim->deferred == NULL &&
         claim->cleanup_deferred == NULL && claim->lifecycle_deferred == NULL &&
         claim->setup_deferred == NULL && claim->setup_audit_state == NULL &&
         claim->settlement_close_state == NULL &&
         (!claim->external_created || claim->external_finalized);
}

static void claim_finalizer(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  atomic_claim *claim = data;
  __atomic_add_fetch(&claim->external_finalizer_calls, 1U, __ATOMIC_RELAXED);
  atomic_claim **cursor = &active_claims;
  while (*cursor != NULL && *cursor != claim) {
    cursor = &(*cursor)->next;
  }
  if (*cursor == claim) {
    *cursor = claim->next;
  }
  claim->external_finalized = 1;
  if (claim->published) {
    return;
  }
  maybe_complete_claim_setup(claim);
  if (preauthority_claim_can_free(claim)) {
    free(claim);
  }
}

static napi_value become_subreaper(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int enabled = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 0 || prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0 ||
      prctl(PR_GET_CHILD_SUBREAPER, &enabled, 0, 0, 0) != 0 || enabled != 1) {
    return throw_test(env, "failed to enable verified child subreaper");
  }
  napi_value undefined_value;
  if (napi_get_undefined(env, &undefined_value) != napi_ok) {
    return throw_test(env, "failed to create subreaper return value");
  }
  return undefined_value;
}

static void settlement_close_state_finalizer(napi_env env, void *data,
                                             void *hint) {
  (void)env;
  (void)data;
  settlement_close_state *state = hint;
  if (__atomic_sub_fetch(&state->references, 1U, __ATOMIC_ACQ_REL) == 0) {
    free(state);
  }
}

static void release_settlement_close_claim_owner(atomic_claim *claim) {
  settlement_close_state *state = claim->settlement_close_state;
  if (state == NULL) {
    return;
  }
  claim->settlement_close_state = NULL;
  if (__atomic_sub_fetch(&state->references, 1U, __ATOMIC_ACQ_REL) == 0) {
    free(state);
  }
}

static int create_mandatory_audit(napi_env env, atomic_claim *claim) {
  if (ATOMIC_PUBLISH_FAULT_VARIANT == ATOMIC_FAULT_SETUP_RESOLVE ||
      consume_fault(claim, ATOMIC_FAULT_AUDIT_CREATE)) {
    return 0;
  }
  napi_value audit;
  napi_value cleanup_complete;
  napi_value lifecycle_complete;
  napi_value close_arraybuffer;
  napi_value close_state;
  napi_value reap_promise;
  settlement_close_state *close_counters = calloc(1, sizeof(*close_counters));
  if (close_counters == NULL) return 0;
  close_counters->references = 1;
  claim->settlement_close_state = close_counters;
  if (napi_create_object(env, &audit) != napi_ok) {
    return 0;
  }
  if (atomic_create_audit_promise(
          claim, env, ATOMIC_FAULT_AUDIT_CLEANUP_PROMISE,
          &claim->cleanup_deferred, &cleanup_complete) != napi_ok) {
    return 0;
  }
  claim->mandatory_deferreds_created++;
  if (atomic_create_audit_promise(
          claim, env, ATOMIC_FAULT_AUDIT_LIFECYCLE_PROMISE,
          &claim->lifecycle_deferred, &lifecycle_complete) != napi_ok) {
    return 0;
  }
  claim->mandatory_deferreds_created++;
  __atomic_add_fetch(&close_counters->references, 1U, __ATOMIC_RELAXED);
  if (atomic_create_audit_external_arraybuffer(
          claim,
          env, close_counters->counters, sizeof(close_counters->counters),
          settlement_close_state_finalizer, close_counters,
          &close_arraybuffer) != napi_ok) {
    __atomic_sub_fetch(&close_counters->references, 1U, __ATOMIC_ACQ_REL);
    return 0;
  }
  if (atomic_create_audit_typedarray(claim, env, close_arraybuffer,
                                     &close_state) != napi_ok ||
      atomic_set_audit_property(claim, env, audit, "cleanupComplete",
                                cleanup_complete) != napi_ok ||
      atomic_set_audit_property(claim, env, audit, "lifecycleComplete",
                                lifecycle_complete) != napi_ok ||
      atomic_set_audit_property(claim, env, audit,
                                "settlementOwnerCloseState",
                                close_state) != napi_ok ||
      atomic_create_promise(claim, env, &claim->deferred, &reap_promise) !=
          napi_ok) {
    return 0;
  }
  claim->mandatory_deferreds_created++;
  if (atomic_create_reference(claim, env, reap_promise, 1,
                              &claim->promise_ref) !=
      napi_ok) {
    return 0;
  }
  if (atomic_create_audit_reference(claim, env, audit, &claim->audit_ref) !=
      napi_ok) {
    return 0;
  }
  return 1;
}

static napi_value prepare_inherited_lock(napi_env env,
                                         napi_callback_info info) {
  static const char *keys[] = {
      "role",
      "nodeExecutableRealpath",
      "nodeExecutableSha256",
      "scriptRealpath",
      "scriptSha256",
      "expectedParentPid",
      "expectedParentStarttime",
      "fd9Device",
      "fd9Inode",
      "fd9Uid",
      "fd9Mode",
      "fd9Nlink",
  };
  size_t argc = 2;
  napi_value argv[2];
  napi_valuetype type;
  int32_t expected_parent;
  uint32_t expected_uid;
  uint32_t expected_mode;
  uint32_t expected_nlink;
  char role[64];
  char node_path[4096];
  char node_hash[65];
  char script_path[4096];
  char script_hash[65];
  char expected_parent_starttime[64];
  char expected_device[64];
  char expected_inode[64];
  char canonical_node[4096];
  char canonical_script[4096];
  char executable[4096];
  char actual_node_hash[65];
  char actual_script_hash[65];
  char self_starttime[64];
  char parent_starttime[64];
  pid_t observed_parent;
  pid_t parent_parent;
  struct stat before;
  struct stat after;
  struct stat ready_boundary;
  struct stat release_boundary;
  int fd_flags_before;
  int fd_flags_after;
  int open_flags_before;
  int open_flags_after;

  if (inherited_lock_prepared ||
      napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok ||
      type != napi_object ||
      !exact_keys(env, argv[0], keys, sizeof(keys) / sizeof(keys[0])) ||
      !read_string_property(env, argv[0], "role", role, sizeof(role)) ||
      (strcmp(role, "orphan_lock_driver_v1") != 0 &&
       strcmp(role, "orphan_lock_descendant_v1") != 0) ||
      !read_string_property(env, argv[0], "nodeExecutableRealpath", node_path,
                            sizeof(node_path)) ||
      !read_string_property(env, argv[0], "nodeExecutableSha256", node_hash,
                            sizeof(node_hash)) ||
      !read_string_property(env, argv[0], "scriptRealpath", script_path,
                            sizeof(script_path)) ||
      !read_string_property(env, argv[0], "scriptSha256", script_hash,
                            sizeof(script_hash)) ||
      !read_int32_property(env, argv[0], "expectedParentPid",
                           &expected_parent) ||
      !read_string_property(env, argv[0], "expectedParentStarttime",
                            expected_parent_starttime,
                            sizeof(expected_parent_starttime)) ||
      !read_string_property(env, argv[0], "fd9Device", expected_device,
                            sizeof(expected_device)) ||
      !read_string_property(env, argv[0], "fd9Inode", expected_inode,
                            sizeof(expected_inode)) ||
      !read_uint32_property(env, argv[0], "fd9Uid", &expected_uid) ||
      !read_uint32_property(env, argv[0], "fd9Mode", &expected_mode) ||
      !read_uint32_property(env, argv[0], "fd9Nlink", &expected_nlink) ||
      expected_uid != getuid() || expected_mode != 0600 ||
      expected_nlink != 1 || getppid() != (pid_t)expected_parent ||
      !authenticate_fixture_control() ||
      !proc_stat(getpid(), &observed_parent, self_starttime,
                 sizeof(self_starttime)) ||
      observed_parent != (pid_t)expected_parent ||
      !proc_stat((pid_t)expected_parent, &parent_parent, parent_starttime,
                 sizeof(parent_starttime)) ||
      strcmp(parent_starttime, expected_parent_starttime) != 0 ||
      fstat(3, &ready_boundary) != 0 ||
      fstat(4, &release_boundary) != 0 ||
      !S_ISFIFO(ready_boundary.st_mode) ||
      !S_ISFIFO(release_boundary.st_mode) ||
      ready_boundary.st_uid != getuid() ||
      release_boundary.st_uid != getuid() ||
      (ready_boundary.st_mode & 07777) != 0600 ||
      (release_boundary.st_mode & 07777) != 0600 ||
      ready_boundary.st_nlink != 0 || release_boundary.st_nlink != 0 ||
      (ready_boundary.st_dev == release_boundary.st_dev &&
       ready_boundary.st_ino == release_boundary.st_ino) ||
      realpath(node_path, canonical_node) == NULL ||
      strcmp(canonical_node, node_path) != 0 ||
      realpath(script_path, canonical_script) == NULL ||
      strcmp(canonical_script, script_path) != 0 ||
      !sha256_file(canonical_node, actual_node_hash) ||
      !sha256_file(canonical_script, actual_script_hash) ||
      strcmp(actual_node_hash, node_hash) != 0 ||
      strcmp(actual_script_hash, script_hash) != 0 ||
      !exact_cmdline(getpid(), canonical_node, canonical_script) ||
      !exact_prepare_environment(role, (pid_t)expected_parent,
                                 expected_parent_starttime)) {
    return throw_test(env, "inherited lock preparation evidence is invalid");
  }
  ssize_t executable_length =
      readlink("/proc/self/exe", executable, sizeof(executable) - 1);
  if (executable_length <= 0 ||
      (size_t)executable_length >= sizeof(executable) - 1) {
    return throw_test(env, "inherited lock executable identity is invalid");
  }
  executable[executable_length] = '\0';
  if (strcmp(executable, canonical_node) != 0 || fstat(9, &before) != 0 ||
      !S_ISREG(before.st_mode) || before.st_uid != getuid() ||
      (before.st_mode & 07777) != 0600 || before.st_nlink != 1 ||
      !authenticate_private_lock(&before)) {
    return throw_test(env, "inherited lock identity is invalid");
  }
  char device[64];
  char inode[64];
  snprintf(device, sizeof(device), "%llu", (unsigned long long)before.st_dev);
  snprintf(inode, sizeof(inode), "%llu", (unsigned long long)before.st_ino);
  if (strcmp(device, expected_device) != 0 ||
      strcmp(inode, expected_inode) != 0 ||
      before.st_uid != expected_uid ||
      (uint32_t)(before.st_mode & 07777) != expected_mode ||
      before.st_nlink != (nlink_t)expected_nlink ||
      (fd_flags_before = fcntl(9, F_GETFD)) < 0 ||
      !parse_procfd_flags(getpid(), &open_flags_before) ||
      fcntl(9, F_SETFD, fd_flags_before & ~FD_CLOEXEC) != 0 ||
      fstat(9, &after) != 0 ||
      (fd_flags_after = fcntl(9, F_GETFD)) < 0 ||
      !parse_procfd_flags(getpid(), &open_flags_after) ||
      after.st_dev != before.st_dev || after.st_ino != before.st_ino ||
      after.st_uid != before.st_uid || after.st_mode != before.st_mode ||
      after.st_nlink != before.st_nlink ||
      (fd_flags_after & FD_CLOEXEC) != 0 ||
      fd_flags_after != (fd_flags_before & ~FD_CLOEXEC) ||
      (open_flags_after & ~O_CLOEXEC) !=
          (open_flags_before & ~O_CLOEXEC) ||
      !authenticate_private_lock(&after)) {
    return throw_test(env, "inherited lock preparation post-check failed");
  }
  inherited_lock_prepared = 1;
  napi_value undefined_value;
  if (napi_get_undefined(env, &undefined_value) != napi_ok) {
    inherited_lock_prepared = 0;
    return throw_test(env, "inherited lock return value is unavailable");
  }
  return undefined_value;
}

static napi_value claim_child(napi_env env, napi_callback_info info) {
  static const char *keys[] = {
      "role",
      "pid",
      "starttime",
      "nodeExecutableRealpath",
      "nodeExecutableSha256",
      "scriptRealpath",
      "scriptSha256",
      "fd9Device",
      "fd9Inode",
      "fd9Uid",
      "fd9Mode",
      "fd9Nlink",
      "adoptiveParentPid",
      "adoptiveParentStarttime",
  };
  size_t argc = 2;
  napi_value argv[2];
  napi_valuetype type;
  int32_t pid;
  int32_t adoptive_parent;
  uint32_t fd9_uid;
  uint32_t fd9_mode;
  uint32_t fd9_nlink;
  char starttime[64];
  char observed_starttime[64];
  char role[64];
  char node_path[4096];
  char node_hash[65];
  char script_path[4096];
  char script_hash[65];
  char fd9_device[64];
  char fd9_inode[64];
  char adoptive_parent_starttime[64];
  pid_t observed_parent;
  int enabled = 0;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 1 || napi_typeof(env, argv[0], &type) != napi_ok ||
      type != napi_object ||
      !exact_keys(env, argv[0], keys, sizeof(keys) / sizeof(keys[0])) ||
      !read_int32_property(env, argv[0], "pid", &pid) ||
      !read_int32_property(env, argv[0], "adoptiveParentPid",
                           &adoptive_parent) ||
      adoptive_parent != getpid() ||
      !read_string_property(env, argv[0], "role", role, sizeof(role)) ||
      strcmp(role, "orphan_lock_descendant_v1") != 0 ||
      !read_string_property(env, argv[0], "starttime", starttime,
                            sizeof(starttime)) ||
      !read_string_property(env, argv[0], "nodeExecutableRealpath", node_path,
                            sizeof(node_path)) ||
      !read_string_property(env, argv[0], "nodeExecutableSha256", node_hash,
                            sizeof(node_hash)) ||
      !read_string_property(env, argv[0], "scriptRealpath", script_path,
                            sizeof(script_path)) ||
      !read_string_property(env, argv[0], "scriptSha256", script_hash,
                            sizeof(script_hash)) ||
      !read_string_property(env, argv[0], "fd9Device", fd9_device,
                            sizeof(fd9_device)) ||
      !read_string_property(env, argv[0], "fd9Inode", fd9_inode,
                            sizeof(fd9_inode)) ||
      !read_uint32_property(env, argv[0], "fd9Uid", &fd9_uid) ||
      !read_uint32_property(env, argv[0], "fd9Mode", &fd9_mode) ||
      !read_uint32_property(env, argv[0], "fd9Nlink", &fd9_nlink) ||
      fd9_uid != getuid() || fd9_mode != 0600 || fd9_nlink != 1 ||
      !read_string_property(env, argv[0], "adoptiveParentStarttime",
                            adoptive_parent_starttime,
                            sizeof(adoptive_parent_starttime)) ||
      prctl(PR_GET_CHILD_SUBREAPER, &enabled, 0, 0, 0) != 0 || enabled != 1 ||
      !proc_stat((pid_t)pid, &observed_parent, observed_starttime,
                 sizeof(observed_starttime)) ||
      observed_parent != getpid() ||
      strcmp(starttime, observed_starttime) != 0 ||
      !validate_identity((pid_t)pid, starttime, node_path, node_hash,
                         script_path, script_hash, fd9_device, fd9_inode,
                         (uid_t)fd9_uid, (mode_t)fd9_mode, (nlink_t)fd9_nlink,
                         adoptive_parent_starttime)) {
    return throw_test(env, "adopted child evidence is invalid");
  }
  for (atomic_claim *cursor = active_claims; cursor != NULL;
       cursor = cursor->next) {
    if (cursor->pid == (pid_t)pid) {
      return throw_test(env, "adopted child was already claimed");
    }
  }
  atomic_claim *claim = calloc(1, sizeof(*claim));
  if (claim == NULL) {
    return throw_test(env, "claim allocation failed");
  }
  claim->owner = &atomic_claim_owner;
  claim->pid = (pid_t)pid;
  claim->pidfd = -1;
  claim->env = env;
  napi_value external;
  napi_ref handle_ref = NULL;
  uv_loop_t *loop = NULL;
  if (napi_get_uv_event_loop(env, &loop) != napi_ok || loop == NULL) {
    napi_value failure =
        throw_claim_setup(claim, "claimed child owner loop is unavailable");
    free(claim);
    return failure;
  }
  claim->settlement_owner_init_requests++;
  if (atomic_settlement_timer_init(claim, loop) != 0) {
    claim->settlement_owner_init_failures++;
    napi_value failure = throw_claim_setup(
        claim, "claimed child settlement owner creation failed");
    free(claim);
    return failure;
  }
  claim->settlement_owner_init_completions++;
  claim->settlement_timer_initialized = 1;
  claim->settlement_timer.data = claim;
  claim->settlement_owner_start_requests++;
  if (atomic_settlement_timer_start(claim) != 0) {
    claim->settlement_owner_start_failures++;
    close_settlement_owner(claim);
    return throw_claim_setup(claim,
                             "claimed child settlement owner start failed");
  }
  claim->settlement_owner_start_completions++;
  claim->settlement_owner_ref_requests++;
  if (!atomic_settlement_timer_ref(claim)) {
    claim->settlement_owner_ref_failures++;
    close_settlement_owner(claim);
    return throw_claim_setup(
        claim, "claimed child settlement owner is not referenced");
  }
  claim->settlement_owner_ref_completions++;
  claim->external_create_requests++;
  if (atomic_create_external(env, claim, claim_finalizer, &external) !=
      napi_ok) {
    claim->preauthority_cleanup = 1;
    return throw_claim_setup(claim, "opaque handle allocation failed");
  }
  claim->external_create_completions++;
  claim->external_created = 1;
  claim->owner_ref_create_requests++;
  if (atomic_create_owner_reference(claim, env, external, &handle_ref) !=
      napi_ok) {
    claim->preauthority_cleanup = 1;
    return throw_claim_setup(claim, "opaque owner allocation failed");
  }
  claim->owner_ref_create_completions++;
  claim->handle_ref = handle_ref;
  if (atomic_timer_init(claim, loop, &claim->cleanup_timer) != 0) {
    claim->preauthority_cleanup = 1;
    return throw_claim_setup(claim,
                             "claimed child cleanup owner creation failed");
  }
  claim->cleanup_timer_initialized = 1;
  claim->cleanup_timer.data = claim;
  if (atomic_timer_start(claim, &claim->cleanup_timer, cleanup_owner_poll, 10,
                         10) != 0) {
    claim->preauthority_cleanup = 1;
    uv_close((uv_handle_t *)&claim->cleanup_timer, cleanup_owner_closed);
    return throw_claim_setup(claim,
                             "claimed child cleanup owner start failed");
  }
  uv_ref((uv_handle_t *)&claim->cleanup_timer);
  if (!uv_has_ref((uv_handle_t *)&claim->cleanup_timer)) {
    claim->preauthority_cleanup = 1;
    uv_close((uv_handle_t *)&claim->cleanup_timer, cleanup_owner_closed);
    return throw_claim_setup(
        claim, "claimed child cleanup owner is not referenced");
  }
  if (!create_mandatory_audit(env, claim)) {
    claim->preauthority_cleanup = 1;
    close_cleanup_owner(claim);
    return throw_claim_setup(claim,
                             "claim audit or Promise allocation failed");
  }
#ifdef SYS_pidfd_open
  int pidfd = (int)syscall(SYS_pidfd_open, pid, 0);
#else
  int pidfd = -1;
  errno = ENOSYS;
#endif
  if (pidfd < 0) {
    claim->preauthority_cleanup = 1;
    close_cleanup_owner(claim);
    return throw_claim_setup(claim, "pidfd binding failed");
  }
  claim->pidfd = pidfd;
#ifdef SYS_pidfd_send_signal
  if (syscall(SYS_pidfd_send_signal, pidfd, 0, NULL, 0) != 0 ||
      !validate_identity((pid_t)pid, starttime, node_path, node_hash,
                         script_path, script_hash, fd9_device, fd9_inode,
                         (uid_t)fd9_uid, (mode_t)fd9_mode, (nlink_t)fd9_nlink,
                         adoptive_parent_starttime)) {
    claim->preauthority_cleanup = 1;
    close_cleanup_owner(claim);
    return throw_claim_setup(claim, "pidfd identity revalidation failed");
  }
#endif
  claim->published = 1;
  claim->next = active_claims;
  active_claims = claim;
  return external;
}

static int64_t monotonic_ms(atomic_claim *claim) {
  struct timespec now;
  if (atomic_clock_gettime(claim, CLOCK_MONOTONIC, &now) != 0 ||
      now.tv_sec < 0 ||
      (uint64_t)now.tv_sec > (uint64_t)INT64_MAX / 1000U) {
    return -1;
  }
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void retain_failure(atomic_claim *claim, const char *category,
                           int error_number) {
  if (claim->failure == 0) {
    claim->failure = error_number == 0 ? EIO : error_number;
    claim->failure_category = category;
  }
}

static int reap_until(atomic_claim *claim, int64_t deadline) {
  for (;;) {
    pid_t result = atomic_waitpid(claim, &claim->wait_status, WNOHANG);
    if (result == claim->pid) {
      __atomic_store_n(&claim->cleanup_reaped, 1, __ATOMIC_RELEASE);
      return 1;
    }
    if (result < 0 && errno != EINTR) {
      retain_failure(claim, "atomic_publish_wait_failed", errno);
      return 0;
    }
    int64_t now = monotonic_ms(claim);
    if (now < 0) {
      retain_failure(claim, "atomic_publish_deadline_failed", EIO);
      return 0;
    }
    if (now >= deadline) {
      return 0;
    }
    struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
    nanosleep(&delay, NULL);
  }
}

static void set_cleanup_owner_state(atomic_claim *claim, int cleanup_mode) {
  if (cleanup_mode) {
    __atomic_store_n(&claim->cleanup_mode, 1, __ATOMIC_RELEASE);
  } else {
    __atomic_store_n(&claim->cleanup_stop, 1, __ATOMIC_RELEASE);
  }
}

static int close_claim_pidfd(atomic_claim *claim) {
  if (claim->pidfd < 0) {
    return 1;
  }
  int descriptor = claim->pidfd;
  __atomic_add_fetch(&claim->pidfd_close_requests, 1U, __ATOMIC_RELAXED);
  if (close(descriptor) == 0) {
    claim->pidfd = -1;
    __atomic_add_fetch(&claim->pidfd_close_completions, 1U,
                       __ATOMIC_RELAXED);
    return 1;
  }
  int close_error = errno;
  if (close_error != EBADF) {
    /*
     * Linux releases the descriptor before reporting late close errors.
     * Retrying this numeric fd could close a concurrently reused descriptor.
     */
    claim->pidfd = -1;
    __atomic_add_fetch(&claim->pidfd_close_completions, 1U,
                       __ATOMIC_RELAXED);
  } else {
    claim->pidfd = -1;
  }
  if (claim->cleanup_failure == 0) {
    claim->cleanup_failure = close_error == 0 ? EIO : close_error;
  }
  if (claim->published) {
    retain_failure(claim, "atomic_publish_pidfd_close_failed",
                   close_error == 0 ? EIO : close_error);
  }
  return 1;
}

static void cleanup_owner_closed(uv_handle_t *handle) {
  atomic_claim *claim = handle->data;
  claim->cleanup_timer_closed = 1;
  __atomic_add_fetch(&claim->cleanup_timer_close_completions, 1U,
                     __ATOMIC_RELAXED);
  if (claim->published &&
      !__atomic_load_n(&claim->cleanup_reaped, __ATOMIC_ACQUIRE)) {
    return;
  }
  maybe_complete_claim_setup(claim);
}

static void close_cleanup_owner(atomic_claim *claim) {
  if (!claim->cleanup_timer_close_requested) {
    if (!close_claim_pidfd(claim)) {
      return;
    }
    claim->cleanup_timer_close_requested = 1;
    __atomic_add_fetch(&claim->cleanup_close_requests, 1U, __ATOMIC_RELAXED);
    uv_timer_stop(&claim->cleanup_timer);
    uv_close((uv_handle_t *)&claim->cleanup_timer, cleanup_owner_closed);
  }
}

static void close_settlement_owner(atomic_claim *claim) {
  if (claim->settlement_timer_initialized &&
      !claim->settlement_timer_close_requested) {
    claim->settlement_timer_close_requested = 1;
    __atomic_add_fetch(&claim->settlement_owner_close_requests, 1U,
                       __ATOMIC_RELAXED);
    if (claim->settlement_close_state != NULL) {
      __atomic_store_n(&claim->settlement_close_state->counters[0], 1U,
                       __ATOMIC_RELEASE);
    }
    uv_timer_stop(&claim->settlement_timer);
    uv_close((uv_handle_t *)&claim->settlement_timer,
             settlement_owner_closed);
  }
}

static void cleanup_owner_poll(uv_timer_t *timer) {
  atomic_claim *claim = timer->data;
  if (claim->preauthority_cleanup && claim->pidfd >= 0) {
    if (close_claim_pidfd(claim)) {
      close_cleanup_owner(claim);
    }
    return;
  }
  int cleanup_mode =
      __atomic_load_n(&claim->cleanup_mode, __ATOMIC_ACQUIRE);
  int cleanup_stop =
      __atomic_load_n(&claim->cleanup_stop, __ATOMIC_ACQUIRE);
  int cleanup_reaped =
      __atomic_load_n(&claim->cleanup_reaped, __ATOMIC_ACQUIRE);
  if (cleanup_reaped) {
    close_cleanup_owner(claim);
    return;
  }
  if (!cleanup_mode && !cleanup_stop) {
    return;
  }
  /*
   * Escalation owns at most one KILL attempt. Once that attempt has happened,
   * this ref'd owner only polls readiness, performs exact-PID wait/reap, and
   * closes resources.
   */
  if (__atomic_load_n(&claim->kill_signal_attempts, __ATOMIC_ACQUIRE) == 0) {
#ifdef SYS_pidfd_send_signal
    if (atomic_pidfd_send_signal(claim, SIGKILL) != 0 &&
        errno != ESRCH && claim->cleanup_failure == 0) {
      claim->cleanup_failure = errno;
    }
#else
    if (claim->cleanup_failure == 0) {
      claim->cleanup_failure = ENOSYS;
    }
#endif
  }
  pid_t result = atomic_waitpid(claim, &claim->wait_status, WNOHANG);
  if (result == claim->pid) {
    __atomic_store_n(&claim->cleanup_reaped, 1, __ATOMIC_RELEASE);
    __atomic_add_fetch(&claim->cleanup_exact_reaps, 1U, __ATOMIC_RELAXED);
    uv_timer_set_repeat(&claim->cleanup_timer, 10);
    return;
  }
  if (result < 0 && errno != EINTR) {
    if (claim->cleanup_failure == 0) {
      claim->cleanup_failure = errno;
    }
    uv_timer_set_repeat(&claim->cleanup_timer, 100);
  } else {
    uv_timer_set_repeat(&claim->cleanup_timer, 10);
  }
}

static void reap_execute(napi_env env, void *data) {
  (void)env;
  atomic_claim *claim = data;
  if (ATOMIC_PUBLISH_FAULT_VARIANT == ATOMIC_FAULT_SETTLEMENT_REJECT) {
    retain_failure(claim, "atomic_publish_settlement_retry_test_failed", EIO);
    set_cleanup_owner_state(claim, 1);
    return;
  }
  int64_t now = monotonic_ms(claim);
  if (now < 0) {
    retain_failure(claim, "atomic_publish_deadline_failed", EIO);
    set_cleanup_owner_state(claim, 1);
    return;
  }
  if (reap_until(claim, now + 2000)) {
    set_cleanup_owner_state(claim, 0);
    return;
  }
#ifdef SYS_pidfd_send_signal
  if (atomic_pidfd_send_signal(claim, SIGTERM) != 0 &&
      errno != ESRCH) {
    retain_failure(claim, "atomic_publish_signal_failed", errno);
    set_cleanup_owner_state(claim, 1);
    return;
  }
#else
  retain_failure(claim, "atomic_publish_signal_failed", ENOSYS);
  set_cleanup_owner_state(claim, 1);
  return;
#endif
  now = monotonic_ms(claim);
  if (now < 0) {
    retain_failure(claim, "atomic_publish_deadline_failed", EIO);
    set_cleanup_owner_state(claim, 1);
    return;
  }
  if (reap_until(claim, now + 1000)) {
    set_cleanup_owner_state(claim, 0);
    return;
  }
  if (atomic_pidfd_send_signal(claim, SIGKILL) != 0 &&
      errno != ESRCH) {
    retain_failure(claim, "atomic_publish_signal_failed", errno);
    set_cleanup_owner_state(claim, 1);
    return;
  }
  now = monotonic_ms(claim);
  if (now < 0) {
    retain_failure(claim, "atomic_publish_deadline_failed", EIO);
    set_cleanup_owner_state(claim, 1);
    return;
  }
  if (!reap_until(claim, now + 1000) && claim->failure == 0) {
    retain_failure(claim, "atomic_publish_reap_timeout", ETIMEDOUT);
    set_cleanup_owner_state(claim, 1);
    return;
  }
  if (claim->failure != 0) {
    set_cleanup_owner_state(claim, 1);
  } else {
    set_cleanup_owner_state(claim, 0);
  }
}

static int set_uint32_property(atomic_claim *claim, napi_env env,
                               napi_value object, const char *name,
                               unsigned number) {
  napi_value value;
  return napi_create_uint32(env, number, &value) == napi_ok &&
         atomic_set_settlement_property(claim, env, object, name, value) ==
             napi_ok;
}

static int prepare_claim_audit(napi_env env, atomic_claim *claim,
                               napi_value *audit) {
  if (claim->audit_prepared) {
    return napi_get_reference_value(env, claim->audit_ref, audit) == napi_ok;
  }
  if (napi_get_reference_value(env, claim->audit_ref, audit) != napi_ok ||
      !set_uint32_property(
          claim, env, *audit, "waitAttempts",
          __atomic_load_n(&claim->wait_attempts, __ATOMIC_RELAXED)) ||
      !set_uint32_property(
          claim, env, *audit, "signalAttempts",
          __atomic_load_n(&claim->signal_attempts, __ATOMIC_RELAXED)) ||
      !set_uint32_property(
          claim, env, *audit, "termSignalAttempts",
          __atomic_load_n(&claim->term_signal_attempts, __ATOMIC_RELAXED)) ||
      !set_uint32_property(
          claim, env, *audit, "killSignalAttempts",
          __atomic_load_n(&claim->kill_signal_attempts, __ATOMIC_RELAXED)) ||
      !set_uint32_property(
          claim, env, *audit, "deadlineAttempts",
          __atomic_load_n(&claim->deadline_attempts, __ATOMIC_RELAXED)) ||
      !set_uint32_property(
          claim, env, *audit, "cleanupCloseRequests",
          __atomic_load_n(&claim->cleanup_close_requests, __ATOMIC_RELAXED)) ||
      napi_object_freeze(env, *audit) != napi_ok) {
    return 0;
  }
  claim->audit_prepared = 1;
  return 1;
}

static int resolve_cleanup_completion(napi_env env, atomic_claim *claim) {
  if (claim->cleanup_deferred == NULL ||
      __atomic_load_n(&claim->cleanup_completion_resolved, __ATOMIC_ACQUIRE) !=
          0) {
    return 1;
  }
  napi_value result;
  napi_value value;
  if (atomic_create_settlement_object(claim, env, &result) != napi_ok ||
      !set_uint32_property(
          claim, env, result, "exactReaps",
          __atomic_load_n(&claim->cleanup_exact_reaps, __ATOMIC_RELAXED)) ||
      !set_uint32_property(
          claim, env, result, "closeRequests",
          __atomic_load_n(&claim->cleanup_close_requests, __ATOMIC_RELAXED)) ||
      !set_uint32_property(
          claim, env, result, "barrierReleases",
          __atomic_load_n(&claim->post_kill_barrier_releases,
                          __ATOMIC_RELAXED)) ||
      napi_get_boolean(env, claim->cleanup_timer_closed != 0, &value) !=
          napi_ok ||
      atomic_set_settlement_property(claim, env, result, "ownerClosed",
                                     value) != napi_ok ||
      napi_object_freeze(env, result) != napi_ok ||
      atomic_resolve_settlement(claim, env, claim->cleanup_deferred, result) !=
          napi_ok) {
    return 0;
  }
  claim->cleanup_deferred = NULL;
  __atomic_store_n(&claim->cleanup_completion_resolved, 1, __ATOMIC_RELEASE);
  return 1;
}

static int set_lifecycle_uint32(atomic_claim *claim, napi_value object,
                                const char *name, unsigned number) {
  napi_value value;
  return napi_create_uint32(claim->env, number, &value) == napi_ok &&
         atomic_set_lifecycle_property(claim, object, name, value) == napi_ok;
}

static int settle_claim_deferred(napi_env env, atomic_claim *claim) {
  napi_value audit;
  if (!prepare_claim_audit(env, claim, &audit)) {
    return 0;
  }
  napi_value result;
  napi_value kind;
  napi_value value;
  if (claim->failure != 0) {
    napi_value message;
    napi_value category;
    napi_value error_number;
    napi_value cleanup;
    const char *failure_category =
        claim->failure_category == NULL ? "atomic_publish_reap_failed"
                                        : claim->failure_category;
    if (napi_create_string_utf8(env, "claimed child reap failed",
                                NAPI_AUTO_LENGTH, &message) != napi_ok ||
        napi_create_error(env, NULL, message, &result) != napi_ok ||
        napi_create_string_utf8(env, failure_category, NAPI_AUTO_LENGTH,
                                &category) != napi_ok ||
        napi_create_int32(env, claim->failure, &error_number) != napi_ok ||
        napi_create_string_utf8(env, "exact_pid_cleanup_owner",
                                NAPI_AUTO_LENGTH, &cleanup) != napi_ok ||
        atomic_set_settlement_property(claim, env, result, "category",
                                       category) != napi_ok ||
        atomic_set_settlement_property(claim, env, result, "errno",
                                       error_number) != napi_ok ||
        atomic_set_settlement_property(claim, env, result, "cleanup",
                                       cleanup) != napi_ok ||
        atomic_set_settlement_property(claim, env, result, "nativeAudit",
                                       audit) != napi_ok ||
        napi_object_freeze(env, result) != napi_ok ||
        atomic_reject_settlement(claim, env, claim->deferred, result) !=
            napi_ok) {
      return 0;
    }
  } else {
    if (atomic_create_settlement_object(claim, env, &result) != napi_ok) {
      return 0;
    }
    if (WIFEXITED(claim->wait_status)) {
      if (napi_create_string_utf8(env, "exit", NAPI_AUTO_LENGTH, &kind) !=
              napi_ok ||
          atomic_set_settlement_property(claim, env, result, "kind", kind) !=
              napi_ok ||
          napi_create_int32(env, WEXITSTATUS(claim->wait_status), &value) !=
              napi_ok ||
          atomic_set_settlement_property(claim, env, result, "code", value) !=
              napi_ok) {
        return 0;
      }
    } else {
      if (napi_create_string_utf8(env, "signal", NAPI_AUTO_LENGTH, &kind) !=
              napi_ok ||
          atomic_set_settlement_property(claim, env, result, "kind", kind) !=
              napi_ok ||
          napi_create_int32(env, WTERMSIG(claim->wait_status), &value) !=
              napi_ok ||
          atomic_set_settlement_property(claim, env, result, "signal",
                                         value) != napi_ok ||
          napi_get_boolean(env, WCOREDUMP(claim->wait_status) != 0, &value) !=
              napi_ok ||
          atomic_set_settlement_property(claim, env, result, "coreDumped",
                                         value) != napi_ok) {
        return 0;
      }
    }
    if (atomic_set_settlement_property(claim, env, result, "nativeAudit",
                                       audit) != napi_ok ||
        napi_object_freeze(env, result) != napi_ok ||
        atomic_resolve_settlement(claim, env, claim->deferred, result) !=
            napi_ok) {
      return 0;
    }
  }
  claim->deferred = NULL;
  claim->settled = 1;
  if (ATOMIC_PUBLISH_FAULT_VARIANT == ATOMIC_FAULT_POST_KILL_TIMEOUT) {
    int expected = 1;
    if (__atomic_compare_exchange_n(&claim->post_kill_barrier_state, &expected,
                                    2, false, __ATOMIC_ACQ_REL,
                                    __ATOMIC_ACQUIRE)) {
      __atomic_add_fetch(&claim->post_kill_barrier_releases, 1U,
                         __ATOMIC_RELAXED);
    }
  }
  return 1;
}

static int delete_preauthority_reference(atomic_claim *claim,
                                         napi_ref *reference) {
  if (*reference == NULL) return 1;
  claim->preauthority_ref_delete_attempts++;
  if (ATOMIC_PUBLISH_FAULT_VARIANT ==
          ATOMIC_FAULT_PREAUTHORITY_REF_DELETE &&
      __atomic_exchange_n(&claim->preauthority_ref_delete_fault_consumed, 1,
                          __ATOMIC_ACQ_REL) == 0) {
    claim->preauthority_ref_delete_failures++;
    return 0;
  }
  if (napi_delete_reference(claim->env, *reference) != napi_ok) return 0;
  *reference = NULL;
  claim->preauthority_ref_delete_completions++;
  return 1;
}

static int settle_setup_deferred(atomic_claim *claim) {
  if (claim->setup_deferred == NULL) {
    return 1;
  }
  napi_value result;
  claim->setup_deferred_settle_requests++;
  if (claim->setup_result_ref == NULL ||
      napi_get_reference_value(claim->env, claim->setup_result_ref, &result) !=
          napi_ok ||
      napi_resolve_deferred(claim->env, claim->setup_deferred, result) !=
          napi_ok) {
    claim->setup_deferred_settle_failures++;
    return 0;
  }
  claim->setup_deferred = NULL;
  claim->setup_deferred_settle_completions++;
  return 1;
}

static int settle_preauthority_deferred(atomic_claim *claim,
                                        napi_deferred *deferred) {
  if (*deferred == NULL) {
    return 1;
  }
  napi_value undefined_value;
  claim->preauthority_deferred_settle_requests++;
  if ((ATOMIC_PUBLISH_FAULT_VARIANT ==
           ATOMIC_FAULT_PREAUTHORITY_DEFERRED_SETTLE &&
       __atomic_exchange_n(&claim->preauthority_deferred_fault_consumed, 1,
                           __ATOMIC_ACQ_REL) == 0) ||
      napi_get_undefined(claim->env, &undefined_value) != napi_ok ||
      napi_resolve_deferred(claim->env, *deferred, undefined_value) !=
          napi_ok) {
    claim->preauthority_deferred_settle_failures++;
    return 0;
  }
  *deferred = NULL;
  claim->preauthority_deferred_settle_completions++;
  claim->mandatory_deferreds_settled++;
  return 1;
}

static int delete_setup_result_reference(atomic_claim *claim) {
  if (claim->setup_result_ref == NULL) {
    return 1;
  }
  claim->setup_result_ref_delete_requests++;
  if (napi_delete_reference(claim->env, claim->setup_result_ref) != napi_ok) {
    claim->setup_result_ref_delete_failures++;
    return 0;
  }
  claim->setup_result_ref = NULL;
  claim->setup_result_ref_delete_completions++;
  return 1;
}

static void settlement_owner_poll(uv_timer_t *timer) {
  atomic_claim *claim = timer->data;
  int had_pending =
      claim->preauthority_cleanup ||
      (claim->async_completion_received && claim->work != NULL) ||
      (claim->primary_settlement_pending && !claim->settled) ||
      (claim->cleanup_timer_closed && !claim->cleanup_completion_resolved) ||
      claim->external_finalized;
  if (!had_pending) {
    return;
  }
  __atomic_add_fetch(&claim->settlement_attempts, 1U, __ATOMIC_RELAXED);
  napi_handle_scope scope;
  if (atomic_open_settlement_scope(claim, claim->env, &scope) != napi_ok) {
    __atomic_add_fetch(&claim->settlement_retries, 1U, __ATOMIC_RELAXED);
    return;
  }
  if (claim->preauthority_cleanup) {
    int deferreds_settled =
        settle_setup_deferred(claim) &&
        settle_preauthority_deferred(claim, &claim->deferred) &&
        settle_preauthority_deferred(claim, &claim->cleanup_deferred) &&
        settle_preauthority_deferred(claim, &claim->lifecycle_deferred);
    int references_released =
        deferreds_settled && delete_setup_result_reference(claim) &&
        delete_preauthority_reference(claim, &claim->promise_ref) &&
        delete_preauthority_reference(claim, &claim->audit_ref) &&
        delete_preauthority_reference(claim, &claim->handle_ref);
    if (!deferreds_settled) {
      claim->settlement_retries++;
      claim->preauthority_settlement_retries++;
    } else if (!references_released) {
      claim->preauthority_ref_delete_retries++;
      claim->settlement_retries++;
      claim->preauthority_settlement_retries++;
    }
    int close_owner =
        deferreds_settled && references_released &&
        (!claim->cleanup_timer_initialized || claim->cleanup_timer_closed) &&
        claim->pidfd < 0 && !claim->settlement_timer_close_requested;
    if (napi_close_handle_scope(claim->env, scope) != napi_ok) {
      claim->settlement_retries++;
      claim->preauthority_settlement_retries++;
      return;
    }
    if (close_owner) {
      close_settlement_owner(claim);
    }
    return;
  }
  if (claim->async_completion_received && claim->work != NULL) {
    __atomic_add_fetch(&claim->async_work_delete_requests, 1U,
                       __ATOMIC_RELAXED);
    if (napi_delete_async_work(claim->env, claim->work) == napi_ok) {
      claim->work = NULL;
      __atomic_add_fetch(&claim->async_work_delete_completions, 1U,
                         __ATOMIC_RELAXED);
    }
  }
  if (claim->primary_settlement_pending && !claim->settled) {
    settle_claim_deferred(claim->env, claim);
  }
  if (claim->cleanup_timer_closed && !claim->cleanup_completion_resolved) {
    resolve_cleanup_completion(claim->env, claim);
  }
  if (claim->settled && claim->cleanup_completion_resolved &&
      claim->work == NULL && claim->handle_ref != NULL) {
    __atomic_add_fetch(&claim->handle_ref_release_requests, 1U,
                       __ATOMIC_RELAXED);
    if (napi_delete_reference(claim->env, claim->handle_ref) == napi_ok) {
      claim->handle_ref = NULL;
      __atomic_add_fetch(&claim->handle_ref_release_completions, 1U,
                         __ATOMIC_RELAXED);
    }
  }
  if (claim->external_finalized && claim->promise_ref != NULL) {
    __atomic_add_fetch(&claim->promise_ref_release_requests, 1U,
                       __ATOMIC_RELAXED);
    if (napi_delete_reference(claim->env, claim->promise_ref) == napi_ok) {
      claim->promise_ref = NULL;
      __atomic_add_fetch(&claim->promise_ref_release_completions, 1U,
                         __ATOMIC_RELAXED);
    }
  }
  if (claim->external_finalized && claim->promise_ref == NULL &&
      !claim->lifecycle_settled) {
    settle_lifecycle_completion(claim);
  }
  int close_owner =
      claim->external_finalized && claim->promise_ref == NULL &&
      claim->lifecycle_settled;
  if (napi_close_handle_scope(claim->env, scope) != napi_ok) {
    __atomic_add_fetch(&claim->settlement_retries, 1U, __ATOMIC_RELAXED);
    return;
  }
  if (close_owner) {
    close_settlement_owner(claim);
  }
  if ((claim->async_completion_received && claim->work != NULL) ||
      (claim->primary_settlement_pending && !claim->settled) ||
      (claim->cleanup_timer_closed && !claim->cleanup_completion_resolved) ||
      (claim->external_finalized && !claim->lifecycle_settled)) {
    __atomic_add_fetch(&claim->settlement_retries, 1U, __ATOMIC_RELAXED);
  }
}

static int settle_lifecycle_completion(atomic_claim *claim) {
  napi_handle_scope scope;
  napi_value result;
  int inject_scope_close_failure = arm_lifecycle_scope_close_fault(claim);
  claim->lifecycle_attempts++;
  if (atomic_open_lifecycle_scope(claim, &scope) != napi_ok) {
    claim->lifecycle_retries++;
    return 0;
  }
  int completed =
      atomic_create_lifecycle_object(claim, &result) == napi_ok &&
      set_lifecycle_uint32(claim, result, "pidfdCloseRequests",
                           claim->pidfd_close_requests) &&
      set_lifecycle_uint32(claim, result, "pidfdCloseCompletions",
                           claim->pidfd_close_completions) &&
      set_lifecycle_uint32(claim, result, "asyncWorkDeleteRequests",
                           claim->async_work_delete_requests) &&
      set_lifecycle_uint32(claim, result, "asyncWorkDeleteCompletions",
                           claim->async_work_delete_completions) &&
      set_lifecycle_uint32(claim, result, "promiseRefReleaseRequests",
                           claim->promise_ref_release_requests) &&
      set_lifecycle_uint32(claim, result, "promiseRefReleaseCompletions",
                           claim->promise_ref_release_completions) &&
      set_lifecycle_uint32(claim, result, "handleRefReleaseRequests",
                           claim->handle_ref_release_requests) &&
      set_lifecycle_uint32(claim, result, "handleRefReleaseCompletions",
                           claim->handle_ref_release_completions) &&
      set_lifecycle_uint32(claim, result, "externalFinalizerCalls",
                           claim->external_finalizer_calls) &&
      set_lifecycle_uint32(claim, result, "cleanupTimerCloseRequests",
                           claim->cleanup_close_requests) &&
      set_lifecycle_uint32(claim, result,
                           "cleanupTimerCloseCompletions",
                           claim->cleanup_timer_close_completions) &&
      set_lifecycle_uint32(claim, result, "settlementAttempts",
                           claim->settlement_attempts) &&
      set_lifecycle_uint32(claim, result, "settlementRetries",
                           claim->settlement_retries) &&
      set_lifecycle_uint32(claim, result, "lifecycleAttempts",
                           claim->lifecycle_attempts) &&
      set_lifecycle_uint32(claim, result, "lifecycleRetries",
                           claim->lifecycle_retries) &&
      set_lifecycle_uint32(claim, result, "lifecycleHandleScopeFailures",
                           claim->lifecycle_handle_scope_failures) &&
      set_lifecycle_uint32(
          claim, result, "lifecycleHandleScopeCloseFailures",
          claim->lifecycle_handle_scope_close_failures) &&
      set_lifecycle_uint32(claim, result, "lifecycleObjectFailures",
                           claim->lifecycle_object_failures) &&
      set_lifecycle_uint32(claim, result, "lifecyclePropertyFailures",
                           claim->lifecycle_property_failures) &&
      set_lifecycle_uint32(claim, result, "lifecycleFreezeFailures",
                           claim->lifecycle_freeze_failures) &&
      set_lifecycle_uint32(claim, result, "lifecycleResolveFailures",
                           claim->lifecycle_resolve_failures) &&
      set_lifecycle_uint32(claim, result, "lifecycleRefDeleteFailures",
                           claim->lifecycle_ref_delete_failures) &&
      atomic_freeze_lifecycle(claim, result) == napi_ok;
  if (completed && claim->audit_ref != NULL) {
    completed = atomic_delete_lifecycle_audit_ref(claim) == napi_ok;
    if (completed) claim->audit_ref = NULL;
  }
  if (completed) {
    completed = atomic_resolve_lifecycle(claim, result) == napi_ok;
    if (completed) claim->lifecycle_deferred = NULL;
  }
  napi_status close_status = atomic_close_lifecycle_scope(
      claim, scope, inject_scope_close_failure);
  if (close_status != napi_ok) {
    /*
     * A successful deferred resolution is irreversible. Never retry it or
     * leave lifecycle_settled false after losing the deferred. Treat a
     * post-resolution scope-close failure as terminal-safe; the settlement
     * owner can close and no duplicate resolution occurs.
     */
    if (completed && claim->lifecycle_deferred == NULL) {
      claim->lifecycle_settled = 1;
      return 1;
    }
    claim->lifecycle_retries++;
    return 0;
  }
  if (!completed) {
    claim->lifecycle_retries++;
    return 0;
  }
  claim->lifecycle_settled = 1;
  return 1;
}

static void settlement_owner_closed(uv_handle_t *handle) {
  atomic_claim *claim = handle->data;
  claim->settlement_timer_closed = 1;
  __atomic_add_fetch(&claim->settlement_owner_close_completions, 1U,
                     __ATOMIC_RELAXED);
  if (claim->settlement_close_state != NULL) {
    __atomic_store_n(&claim->settlement_close_state->counters[1], 1U,
                     __ATOMIC_RELEASE);
    release_settlement_close_claim_owner(claim);
  }
  if (!claim->published) {
    maybe_complete_claim_setup(claim);
    if (preauthority_claim_can_free(claim)) {
      free(claim);
    }
    return;
  }
  free(claim);
}

static void reap_complete(napi_env env, napi_status status, void *data) {
  (void)env;
  atomic_claim *claim = data;
  if (status != napi_ok) {
    retain_failure(claim, "atomic_publish_reap_completion_failed", EIO);
    set_cleanup_owner_state(claim, 1);
  }
  if (__atomic_load_n(&claim->cleanup_reaped, __ATOMIC_ACQUIRE)) {
    close_cleanup_owner(claim);
  }
  claim->async_completion_received = 1;
  claim->primary_settlement_pending = 1;
}

static napi_value reap_child(napi_env env, napi_callback_info info) {
  static const char *policy_keys[] = {
      "gracefulTimeoutMs", "termTimeoutMs", "killTimeoutMs"};
  size_t argc = 3;
  napi_value argv[3];
  napi_valuetype type;
  atomic_claim *claim;
  void *external;
  int32_t graceful;
  int32_t term;
  int32_t kill;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok ||
      argc != 2 ||
      napi_get_value_external(env, argv[0], &external) != napi_ok ||
      napi_typeof(env, argv[1], &type) != napi_ok ||
      type != napi_object ||
      !exact_keys(env, argv[1], policy_keys,
                  sizeof(policy_keys) / sizeof(policy_keys[0])) ||
      !read_int32_property(env, argv[1], "gracefulTimeoutMs", &graceful) ||
      !read_int32_property(env, argv[1], "termTimeoutMs", &term) ||
      !read_int32_property(env, argv[1], "killTimeoutMs", &kill) ||
      graceful != 2000 || term != 1000 || kill != 1000) {
    return throw_test(env, "opaque handle or reap policy is invalid");
  }
  claim = NULL;
  for (atomic_claim *cursor = active_claims; cursor != NULL;
       cursor = cursor->next) {
    if ((void *)cursor == external) {
      claim = cursor;
      break;
    }
  }
  if (claim == NULL || claim->owner != &atomic_claim_owner) {
    return throw_test(env, "opaque handle or reap policy is invalid");
  }
  napi_value promise;
  if (claim->promise_ref == NULL ||
      napi_get_reference_value(env, claim->promise_ref, &promise) != napi_ok) {
    return throw_test(env, "claimed child Promise is unavailable");
  }
  if (claim->started) {
    return promise;
  }
  napi_value name;
  napi_async_work work = NULL;
  claim->started = 1;
  if (napi_create_string_utf8(env, "atomicClaimedChildReap", NAPI_AUTO_LENGTH,
                              &name) != napi_ok ||
      atomic_create_async_work(claim, env, NULL, name, reap_execute,
                               reap_complete, claim, &work) != napi_ok) {
    retain_failure(claim, "atomic_publish_reap_job_creation_failed", EIO);
    claim->work = work;
    claim->async_completion_received = work != NULL;
    set_cleanup_owner_state(claim, 1);
    claim->primary_settlement_pending = 1;
    return promise;
  }
  claim->work = work;
  if (atomic_queue_async_work(claim, env, claim->work) != napi_ok) {
    retain_failure(claim, "atomic_publish_reap_queue_failed", EIO);
    claim->async_completion_received = 1;
    set_cleanup_owner_state(claim, 1);
    claim->primary_settlement_pending = 1;
    return promise;
  }
  return promise;
}

napi_status atomic_publish_export_test_hooks(napi_env env, napi_value exports) {
  napi_value hooks;
  napi_value become;
  napi_value prepare;
  napi_value claim;
  napi_value reap;
  if (napi_create_object(env, &hooks) != napi_ok ||
      napi_create_function(env, "becomeChildSubreaperForTest", NAPI_AUTO_LENGTH,
                           become_subreaper, NULL, &become) != napi_ok ||
      napi_create_function(env, "prepareInheritedLockFdForTest",
                           NAPI_AUTO_LENGTH, prepare_inherited_lock, NULL,
                           &prepare) != napi_ok ||
      napi_create_function(env, "claimAdoptedChildForTest", NAPI_AUTO_LENGTH,
                           claim_child, NULL, &claim) != napi_ok ||
      napi_create_function(env, "reapClaimedChildForTest", NAPI_AUTO_LENGTH,
                           reap_child, NULL, &reap) != napi_ok ||
      napi_set_named_property(env, hooks, "becomeChildSubreaperForTest",
                              become) != napi_ok ||
      napi_set_named_property(env, hooks, "prepareInheritedLockFdForTest",
                              prepare) != napi_ok ||
      napi_set_named_property(env, hooks, "claimAdoptedChildForTest", claim) !=
          napi_ok ||
      napi_set_named_property(env, hooks, "reapClaimedChildForTest", reap) !=
          napi_ok ||
      napi_object_freeze(env, hooks) != napi_ok ||
      napi_set_named_property(env, exports, "testHooks", hooks) != napi_ok) {
    return napi_generic_failure;
  }
  return napi_ok;
}
