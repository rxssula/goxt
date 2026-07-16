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

const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_IMAGE_PIXELS = 40_000_000

const assertPixelLimit = (width: number, height: number): void => {
  if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
    throw new Error("Image exceeds the 40 megapixel limit")
  }
}

const jpegDimensions = (bytes: Uint8Array): readonly [number, number] => {
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]!
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    if (length < 2) break
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return [
        (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
        (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      ]
    }
    offset += 2 + length
  }
  throw new Error("JPEG dimensions could not be read")
}

export const readMacClipboardImage = async (): Promise<ClipboardImage | undefined> => {
  if (process.platform !== "darwin") return undefined
  const { readNativeMacClipboardImage } = await import("./macos-clipboard.js")
  return readNativeMacClipboardImage()
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
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 25 MB size limit")
  const format = detectImageFormat(bytes)
  if (format === "PNG") {
    if (bytes.length < 24) throw new Error("Invalid PNG header")
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    assertPixelLimit(header.getUint32(16), header.getUint32(20))
    const image = PNG.sync.read(Buffer.from(bytes))
    return { data: new Uint8Array(image.data), width: image.width, height: image.height, format }
  }
  if (format === "JPEG") {
    assertPixelLimit(...jpegDimensions(bytes))
    const image = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true })
    return { data: new Uint8Array(image.data), width: image.width, height: image.height, format }
  }
  if (format === "TIFF") {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const page = UTIF.decode(buffer)[0]
    if (page === undefined) throw new Error("TIFF has no image pages")
    assertPixelLimit(page.width, page.height)
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
