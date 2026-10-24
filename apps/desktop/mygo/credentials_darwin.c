#include "credentials_darwin.h"
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>

static CFMutableDictionaryRef credential_query(int namespace_id) {
    CFStringRef service = namespace_id == 0 ? CFSTR("dev.ruukoto.desktop.mygo.credentials.production") : CFSTR("dev.ruukoto.desktop.mygo.credentials.development");
    CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecAttrService, service);
    CFDictionarySetValue(query, kSecAttrAccount, CFSTR("personal-remote.v1"));
    return query;
}
int ruukoto_credentials_read(int namespace_id, void **bytes, size_t *size) {
    CFMutableDictionaryRef query = credential_query(namespace_id);
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching(query, &result);
    if (status == errSecSuccess) {
        if (!result || CFGetTypeID(result) != CFDataGetTypeID() || CFDataGetLength((CFDataRef)result) > 65536) status = errSecDecode;
        else {
            *size = CFDataGetLength((CFDataRef)result);
            *bytes = malloc(*size ? *size : 1);
            if (!*bytes) status = errSecAllocate;
            else memcpy(*bytes, CFDataGetBytePtr((CFDataRef)result), *size);
        }
    }
    if (result) CFRelease(result);
    CFRelease(query);
    return status;
}
int ruukoto_credentials_write(int namespace_id, const void *bytes, size_t size) {
    CFMutableDictionaryRef query = credential_query(namespace_id);
    CFDataRef value = CFDataCreate(NULL, bytes, size);
    SecAccessRef access = NULL;
    // NULL trustedlist 只信任当前创建应用，不授权通用 Node 或其他外壳。
    OSStatus status = SecAccessCreate(CFSTR("Ruukoto MyGo Personal"), NULL, &access);
    if (status == errSecSuccess) {
        CFDictionarySetValue(query, kSecAttrAccess, access);
        CFDictionarySetValue(query, kSecValueData, value);
        status = SecItemAdd(query, NULL);
        CFRelease(access);
        if (status == errSecDuplicateItem) {
            CFRelease(query);
            query = credential_query(namespace_id);
            const void *key = kSecValueData;
            const void *data = value;
            CFDictionaryRef update = CFDictionaryCreate(NULL, &key, &data, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
            status = SecItemUpdate(query, update);
            CFRelease(update);
        }
    }
    CFRelease(value); CFRelease(query);
    return status;
}
int ruukoto_credentials_remove(int namespace_id) {
    CFMutableDictionaryRef query = credential_query(namespace_id);
    OSStatus status = SecItemDelete(query);
    CFRelease(query);
    return status;
}
