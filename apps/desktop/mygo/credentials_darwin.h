#include <stddef.h>
#include <Security/Security.h>
int ruukoto_credentials_read(int namespace_id, void **bytes, size_t *size);
int ruukoto_credentials_write(int namespace_id, const void *bytes, size_t size);
int ruukoto_credentials_remove(int namespace_id);
