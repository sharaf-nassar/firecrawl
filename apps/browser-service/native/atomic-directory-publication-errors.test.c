#include <errno.h>
#include <stdio.h>
#include <string.h>

const char *atomic_publish_map_errno_alias(int error_number);
const char *atomic_publish_map_errno_distinct(int error_number);

static int require_unsupported(const char *name, const char *value) {
  if (strcmp(value, "atomic_publish_unsupported") == 0) {
    return 0;
  }
  fprintf(stderr, "%s mapped to %s\n", name, value);
  return 1;
}

static int require_mapping(const char *variant,
                           const char *(*map_errno)(int), int number,
                           const char *expected) {
  const char *actual = map_errno(number);
  if (strcmp(actual, expected) == 0) {
    return 0;
  }
  fprintf(stderr, "%s errno %d mapped to %s instead of %s\n", variant, number,
          actual, expected);
  return 1;
}

static int exercise_common(const char *variant,
                           const char *(*map_errno)(int)) {
  int failed = 0;
  failed |= require_mapping(variant, map_errno, EEXIST,
                            "atomic_publish_exists");
  failed |= require_mapping(variant, map_errno, ENOTEMPTY,
                            "atomic_publish_exists");
  failed |= require_mapping(variant, map_errno, ENOSYS,
                            "atomic_publish_unsupported");
  failed |= require_mapping(variant, map_errno, EINVAL,
                            "atomic_publish_unsupported");
  failed |= require_mapping(variant, map_errno, EXDEV,
                            "atomic_publish_cross_device");
  failed |= require_mapping(variant, map_errno, ENOENT,
                            "atomic_publish_source_missing");
  failed |= require_mapping(variant, map_errno, EBADF,
                            "atomic_publish_binding_invalid");
  failed |= require_mapping(variant, map_errno, ENOTDIR,
                            "atomic_publish_binding_invalid");
#ifdef ELOOP
  failed |= require_mapping(variant, map_errno, ELOOP,
                            "atomic_publish_binding_invalid");
#endif
#ifdef ESTALE
  failed |= require_mapping(variant, map_errno, ESTALE,
                            "atomic_publish_binding_invalid");
#endif
  failed |= require_mapping(variant, map_errno, EACCES,
                            "atomic_publish_denied");
  failed |= require_mapping(variant, map_errno, EPERM,
                            "atomic_publish_denied");
  failed |= require_mapping(variant, map_errno, EROFS,
                            "atomic_publish_denied");
  failed |= require_mapping(variant, map_errno, 1999, "atomic_publish_io");
  return failed;
}

int main(void) {
  int failed = 0;
  failed |= exercise_common("alias", atomic_publish_map_errno_alias);
  failed |= exercise_common("distinct", atomic_publish_map_errno_distinct);
  failed |= require_unsupported("alias ENOTSUP",
                                atomic_publish_map_errno_alias(2000));
  failed |= require_unsupported("alias EOPNOTSUPP",
                                atomic_publish_map_errno_alias(2000));
  failed |= require_unsupported("distinct ENOTSUP",
                                atomic_publish_map_errno_distinct(2000));
  failed |= require_unsupported("distinct EOPNOTSUPP",
                                atomic_publish_map_errno_distinct(2001));
  return failed;
}
