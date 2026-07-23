#ifndef ATOMIC_DIRECTORY_PUBLICATION_TEST_HOOKS_H
#define ATOMIC_DIRECTORY_PUBLICATION_TEST_HOOKS_H

#include <node_api.h>

void atomic_publish_test_hook_before(void);
void atomic_publish_test_hook_after(void);
napi_status atomic_publish_export_test_hooks(napi_env env, napi_value exports);

#endif
