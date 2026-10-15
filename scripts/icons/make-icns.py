#!/usr/bin/env python3
"""Monta build/icon.icns a partir dos PNGs de build/icons/ (formato ICNS com entradas PNG).

Uso: python3 scripts/icons/make-icns.py <dir-com-NxN.png> <saida.icns>
"""
import os
import struct
import sys

# tipo OSType → tamanho em px do PNG (entradas PNG suportadas desde o macOS 10.7)
ENTRIES = [
    ('icp4', 16), ('icp5', 32), ('icp6', 64),
    ('ic07', 128), ('ic08', 256), ('ic09', 512), ('ic10', 1024),
    ('ic11', 32), ('ic12', 64), ('ic13', 256), ('ic14', 512),
]


def main(src: str, dst: str) -> None:
    chunks = []
    for ostype, px in ENTRIES:
        with open(os.path.join(src, f'{px}x{px}.png'), 'rb') as f:
            data = f.read()
        chunks.append(ostype.encode('ascii') + struct.pack('>I', len(data) + 8) + data)
    body = b''.join(chunks)
    with open(dst, 'wb') as f:
        f.write(b'icns' + struct.pack('>I', len(body) + 8) + body)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
