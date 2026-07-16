import jpeg from "jpeg-js"
import { PNG } from "pngjs"
import * as UTIF from "utif"

export interface DecodedImage {
  readonly data: Uint8Array
  readonly width: number
  readonly height: number
  readonly format: "PNG" | "JPEG" | "TIFF"
}

export interface ClipboardImage {
  readonly bytes: Uint8Array
  readonly mimeType: string
}

export const readMacClipboardImage = async (): Promise<ClipboardImage | undefined> => {
  if (process.platform !== "darwin") return undefined
  const script = `
    ObjC.import("AppKit");
    const pasteboard = $.NSPasteboard.generalPasteboard;
    const types = [["public.png", "image/png"], ["public.tiff", "image/tiff"]];
    let result = "";
    for (const [type, mime] of types) {
      const data = pasteboard.dataForType(type);
      if (data) {
        result = mime + "\\t" + data.base64EncodedStringWithOptions(0).js;
        break;
      }
    }
    result;
  `
  const child = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [output, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  if (exitCode !== 0) return undefined
  const separator = output.indexOf("\t")
  if (separator < 0) return undefined
  const mimeType = output.slice(0, separator).trim()
  const base64 = output.slice(separator + 1).trim()
  if (!mimeType.startsWith("image/") || base64.length === 0) return undefined
  return { bytes: Uint8Array.from(Buffer.from(base64, "base64")), mimeType }
}

export const detectImageFormat = (bytes: Uint8Array): DecodedImage["format"] | undefined => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "PNG"
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "JPEG"
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 0x2a)
  ) return "TIFF"
  return undefined
}

export const decodeImage = (bytes: Uint8Array): DecodedImage => {
  const format = detectImageFormat(bytes)
  if (format === "PNG") {
    const image = PNG.sync.read(Buffer.from(bytes))
    return { data: new Uint8Array(image.data), width: image.width, height: image.height, format }
  }
  if (format === "JPEG") {
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true })
    return { data: new Uint8Array(image.data), width: image.width, height: image.height, format }
  }
  if (format === "TIFF") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const page = UTIF.decode(buffer)[0]
    if (page === undefined) throw new Error("TIFF has no image pages")
    UTIF.decodeImage(buffer, page)
    return {
      data: new Uint8Array(UTIF.toRGBA8(page)),
      width: page.width,
      height: page.height,
      format,
    }
  }
  throw new Error("Unsupported clipboard image format")
}

export const resizeImage = (
  image: DecodedImage,
  maxWidth: number,
  maxHeight: number,
): DecodedImage => {
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  if (width === image.width && height === image.height) return image
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / scale))
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / scale))
      const source = (sourceY * image.width + sourceX) * 4
      const target = (y * width + x) * 4
      data.set(image.data.subarray(source, source + 4), target)
    }
  }
  return { ...image, data, width, height }
}

export const encodeImageAsPng = (image: DecodedImage): Uint8Array =>
  new Uint8Array(PNG.sync.write({
    data: Buffer.from(image.data),
    width: image.width,
    height: image.height,
  } as PNG))
