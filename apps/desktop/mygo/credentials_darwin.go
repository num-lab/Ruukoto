package main

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#cgo CFLAGS: -Wno-deprecated-declarations
#include "credentials_darwin.h"
#include <stdlib.h>
*/
import "C"
import (
	"errors"
	"sync"
	"unsafe"
)

type credentialStore interface {
	request(op string, value *string) (*string, error)
}

type nativeCredentials struct {
	mu        sync.Mutex
	namespace C.int
}

func newNativeCredentials(namespace string) (*nativeCredentials, error) {
	switch namespace {
	case "production":
		return &nativeCredentials{namespace: 0}, nil
	case "development":
		return &nativeCredentials{namespace: 1}, nil
	default:
		return nil, errors.New("凭据命名空间无效")
	}
}

func (s *nativeCredentials) request(op string, value *string) (*string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var status C.int
	switch op {
	case "read":
		var bytes unsafe.Pointer
		var size C.size_t
		status = C.ruukoto_credentials_read(s.namespace, &bytes, &size)
		if status == C.errSecItemNotFound {
			return nil, nil
		}
		if status == 0 {
			defer C.free(bytes)
			if size > 65536 {
				return nil, errors.New("凭据载荷超限")
			}
			result := string(C.GoBytes(bytes, C.int(size)))
			return &result, nil
		}
	case "write":
		if value == nil || len(*value) > 65536 {
			return nil, errors.New("凭据载荷无效")
		}
		bytes := C.CBytes([]byte(*value))
		defer C.free(bytes)
		status = C.ruukoto_credentials_write(s.namespace, bytes, C.size_t(len(*value)))
	case "remove":
		status = C.ruukoto_credentials_remove(s.namespace)
		if status == C.errSecItemNotFound {
			return nil, nil
		}
	default:
		return nil, errors.New("凭据操作无效")
	}
	if status != 0 {
		return nil, errors.New("安全存储不可用")
	}
	return nil, nil
}
