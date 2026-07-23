#define _GNU_SOURCE

#include <node_api.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/stat.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include "atomic-directory-publication-errors.h"

#ifdef ATOMIC_PUBLISH_TEST_HOOKS
#include "atomic-directory-publication-test-hooks.h"
#endif

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

static napi_value throw_napi_failure(napi_env env) {
  if (napi_throw_error(env, "atomic_publish_napi_failure",
                       "atomic publication native operation failed") !=
      napi_ok) {
    return NULL;
  }
  return NULL;
}

static napi_value throw_code(napi_env env, const char *code) {
  napi_value message;
  napi_value error;
  napi_value code_value;
  const char *detail = code;
  if (strcmp(code, "atomic_publish_exists") == 0) {
    detail = "atomic_publish_exists: target_exists";
  }
  if (napi_create_string_utf8(env, detail, NAPI_AUTO_LENGTH, &message) !=
          napi_ok ||
      napi_create_error(env, NULL, message, &error) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) !=
          napi_ok ||
      napi_set_named_property(env, error, "code", code_value) != napi_ok ||
      napi_throw(env, error) != napi_ok) {
    return throw_napi_failure(env);
  }
  return NULL;
}

static int read_fd(napi_env env, napi_value value, int *result) {
  napi_valuetype type;
  double number;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok ||
      !isfinite(number) || floor(number) != number || number < 0 ||
      number > INT32_MAX) {
    return 0;
  }
  *result = (int)number;
  return 1;
}

static int valid_leaf_bytes(const char *leaf, size_t length) {
  if (length < 1 || length > 128 ||
      (length == 1 && leaf[0] == '.') ||
      (length == 2 && leaf[0] == '.' && leaf[1] == '.')) {
    return 0;
  }
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = (unsigned char)leaf[index];
    if (byte == 0 || byte > 0x7f || byte == '/' || byte == '\\') {
      return 0;
    }
    int edge = index == 0 || index + 1 == length;
    int alpha_numeric =
        (byte >= 'a' && byte <= 'z') || (byte >= '0' && byte <= '9');
    int inner_punctuation = byte == '.' || byte == '_' || byte == '-';
    if (!alpha_numeric && (edge || !inner_punctuation)) {
      return 0;
    }
  }
  return 1;
}

static int read_leaf(napi_env env, napi_value value, char leaf[129]) {
  napi_valuetype type;
  size_t length = 0;
  size_t copied = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length > 128 ||
      napi_get_value_string_utf8(env, value, leaf, 129, &copied) != napi_ok ||
      copied != length || !valid_leaf_bytes(leaf, length)) {
    return 0;
  }
  return 1;
}

static int directory_identity(int fd, dev_t *device, uint64_t *mount_id) {
  struct stat status;
  if (fstat(fd, &status) != 0) {
    return errno;
  }
  if (!S_ISDIR(status.st_mode)) {
    return ENOTDIR;
  }
  *device = status.st_dev;

#if defined(SYS_statx) && defined(STATX_MNT_ID)
  struct statx extended;
  memset(&extended, 0, sizeof(extended));
  if (syscall(SYS_statx, fd, "",
              AT_EMPTY_PATH | AT_NO_AUTOMOUNT | AT_STATX_SYNC_AS_STAT,
              STATX_MNT_ID, &extended) != 0) {
    return errno;
  }
  if ((extended.stx_mask & STATX_MNT_ID) == 0) {
    return EOPNOTSUPP;
  }
  *mount_id = extended.stx_mnt_id;
  return 0;
#else
  (void)mount_id;
  return ENOSYS;
#endif
}

static napi_value rename_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok) {
    return throw_napi_failure(env);
  }
  if (argc != 4) {
    return throw_code(env, "atomic_publish_invalid_argument");
  }

  int source_fd;
  int target_fd;
  char source_leaf[129];
  char target_leaf[129];
  if (!read_fd(env, argv[0], &source_fd) ||
      !read_leaf(env, argv[1], source_leaf) ||
      !read_fd(env, argv[2], &target_fd) ||
      !read_leaf(env, argv[3], target_leaf)) {
    return throw_code(env, "atomic_publish_invalid_argument");
  }

  dev_t source_device;
  dev_t target_device;
  uint64_t source_mount;
  uint64_t target_mount;
  int identity_error =
      directory_identity(source_fd, &source_device, &source_mount);
  if (identity_error == 0) {
    identity_error =
        directory_identity(target_fd, &target_device, &target_mount);
  }
  if (identity_error != 0) {
    return throw_code(env, atomic_publish_map_errno(identity_error));
  }
  if (source_device != target_device || source_mount != target_mount) {
    return throw_code(env, "atomic_publish_cross_device");
  }

#ifdef ATOMIC_PUBLISH_TEST_HOOKS
  if (source_fd != 4 || target_fd != 5 ||
      !atomic_publish_test_hook_before()) {
    return throw_code(env, "atomic_publish_test_hook_invalid");
  }
#endif
#ifdef SYS_renameat2
  int result = (int)syscall(SYS_renameat2, source_fd, source_leaf, target_fd,
                            target_leaf, RENAME_NOREPLACE);
#else
  errno = ENOSYS;
  int result = -1;
#endif
  int syscall_error = errno;
#ifdef ATOMIC_PUBLISH_TEST_HOOKS
  if (!atomic_publish_test_hook_after()) {
    return throw_code(env, "atomic_publish_test_hook_invalid");
  }
#endif
  if (result != 0) {
    return throw_code(env, atomic_publish_map_errno(syscall_error));
  }
  napi_value undefined_value;
  if (napi_get_undefined(env, &undefined_value) != napi_ok) {
    return throw_napi_failure(env);
  }
  return undefined_value;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value interface_version;
  napi_value napi_version;
  napi_value rename_function;

  if (napi_create_string_utf8(env, "1.0.0", NAPI_AUTO_LENGTH,
                              &interface_version) != napi_ok ||
      napi_create_uint32(env, 8, &napi_version) != napi_ok ||
      napi_create_function(env, "renameNoReplace", NAPI_AUTO_LENGTH,
                           rename_no_replace, NULL, &rename_function) !=
          napi_ok ||
      napi_set_named_property(env, exports, "interfaceVersion",
                              interface_version) != napi_ok ||
      napi_set_named_property(env, exports, "napiVersion", napi_version) !=
          napi_ok ||
      napi_set_named_property(env, exports, "renameNoReplace",
                              rename_function) != napi_ok) {
    return throw_napi_failure(env);
  }
#ifdef ATOMIC_PUBLISH_TEST_HOOKS
  if (!atomic_publish_test_hook_capture_addon_identity() ||
      atomic_publish_export_test_hooks(env, exports) != napi_ok) {
    if (napi_throw_error(env, "atomic_publish_test_hook_init",
                         "failed to initialize test hooks") != napi_ok) {
      return NULL;
    }
    return NULL;
  }
#endif
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
