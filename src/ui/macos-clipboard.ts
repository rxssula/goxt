import { CString, FFIType, dlopen, ptr, toArrayBuffer, type Pointer } from "bun:ffi"

const objc = dlopen("/usr/lib/libobjc.A.dylib", {
  objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
  sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
  objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
})

// Loading AppKit registers NSPasteboard with the Objective-C runtime.
const appKit = dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", {
  NSApplicationMain: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
})

const selector = (name: string): Pointer => objc.symbols.sel_registerName(Buffer.from(`${name}\0`))!
const getClass = (name: string): Pointer => objc.symbols.objc_getClass(Buffer.from(`${name}\0`))!
const send = (target: Pointer, name: string, argument: Pointer | null = null): Pointer | null =>
  objc.symbols.objc_msgSend(target, selector(name), argument)

const nsString = (value: string): Pointer | null =>
  send(getClass("NSString"), "stringWithUTF8String:", ptr(Buffer.from(`${value}\0`)))

export const readNativeMacClipboardImage = (): { bytes: Uint8Array; mimeType: string } | undefined => {
  // Keep the framework handle alive for the duration of the calls below.
  void appKit
  const pasteboard = send(getClass("NSPasteboard"), "generalPasteboard")
  if (pasteboard === null) return undefined

  for (const [type, mimeType] of [["public.png", "image/png"], ["public.tiff", "image/tiff"]] as const) {
    const nativeType = nsString(type)
    if (nativeType === null) continue
    const data = send(pasteboard, "dataForType:", nativeType)
    if (data === null) continue
    const bytes = send(data, "bytes")
    const length = Number(send(data, "length"))
    if (bytes === null || length <= 0) continue
    return { bytes: new Uint8Array(toArrayBuffer(bytes, 0, length)).slice(), mimeType }
  }
  return undefined
}
