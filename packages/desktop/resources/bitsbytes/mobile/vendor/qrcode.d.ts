declare function qrcode(type: number, correction: string): { addData(value: string): void; make(): void; createDataURL(size?: number, margin?: number): string }
export default qrcode
