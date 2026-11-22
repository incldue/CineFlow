export function writeHeader(magic, fields) {
    const m = Buffer.from(magic, 'ascii');
    const f = Buffer.alloc(fields.length * 4);
    fields.forEach((v, i) => f.writeUInt32LE(v, i * 4));
    return Buffer.concat([m, f]);
}
export function readHeader(buf, fieldCount) {
    return {
        magic: buf.subarray(0, 4).toString('ascii'),
        fields: Array.from({ length: fieldCount }, (_, i) => buf.readUInt32LE(4 + i * 4)),
    };
}

export function readTyped(buf, Ctor, off, count) {
    const bytes = count * Ctor.BYTES_PER_ELEMENT;
    const copy = new Uint8Array(bytes);
    copy.set(buf.subarray(off, off + bytes));
    return new Ctor(copy.buffer);
}

export function typedBuffer(arr) {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
