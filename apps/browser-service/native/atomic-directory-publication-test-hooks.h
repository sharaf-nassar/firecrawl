#ifndef ATOMIC_DIRECTORY_PUBLICATION_TEST_HOOKS_H
#define ATOMIC_DIRECTORY_PUBLICATION_TEST_HOOKS_H

#include <node_api.h>

int atomic_publish_test_hook_before(void);
int atomic_publish_test_hook_after(void);
int atomic_publish_test_hook_capture_addon_identity(void);
napi_status atomic_publish_export_test_hooks(napi_env env, napi_value exports);

#endif
