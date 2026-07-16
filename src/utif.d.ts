declare module "utif" {
  export interface TiffPage {
    width: number
    height: number
  }

  export function decode(buffer: ArrayBuffer): TiffPage[]
  export function decodeImage(buffer: ArrayBuffer, page: TiffPage): void
  export function toRGBA8(page: TiffPage): ArrayBuffer
}
