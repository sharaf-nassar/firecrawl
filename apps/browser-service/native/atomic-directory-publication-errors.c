#include "atomic-directory-publication-errors.h"

#include <errno.h>

#if defined(ATOMIC_PUBLISH_ERRNO_VARIANT_ALIAS) && \
    defined(ATOMIC_PUBLISH_ERRNO_VARIANT_DISTINCT)
#error "select exactly one errno test variant"
#endif

#if defined(ATOMIC_PUBLISH_ERRNO_VARIANT_ALIAS)
#define ATOMIC_PUBLISH_ENOTSUP 2000
#define ATOMIC_PUBLISH_EOPNOTSUPP 2000
#elif defined(ATOMIC_PUBLISH_ERRNO_VARIANT_DISTINCT)
#define ATOMIC_PUBLISH_ENOTSUP 2000
#define ATOMIC_PUBLISH_EOPNOTSUPP 2001
#else
#define ATOMIC_PUBLISH_ENOTSUP ENOTSUP
#define ATOMIC_PUBLISH_EOPNOTSUPP EOPNOTSUPP
#endif

const char *atomic_publish_map_errno(int error_number) {
  switch (error_number) {
  case EEXIST:
  case ENOTEMPTY:
    return "atomic_publish_exists";
  case ENOSYS:
  case EINVAL:
    return "atomic_publish_unsupported";
  case EXDEV:
    return "atomic_publish_cross_device";
  case ENOENT:
    return "atomic_publish_source_missing";
  case EBADF:
  case ENOTDIR:
#ifdef ELOOP
  case ELOOP:
#endif
#ifdef ESTALE
  case ESTALE:
#endif
    return "atomic_publish_binding_invalid";
  case EACCES:
  case EPERM:
  case EROFS:
    return "atomic_publish_denied";
  default:
    break;
  }

  if (error_number == ATOMIC_PUBLISH_EOPNOTSUPP ||
      error_number == ATOMIC_PUBLISH_ENOTSUP) {
    return "atomic_publish_unsupported";
  }
  return "atomic_publish_io";
}
