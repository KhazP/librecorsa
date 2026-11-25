# BC7 decoder

`bc7-wasm.ts` embeds the BC7 part of [bcdec 0.985](https://github.com/iOrange/bcdec/tree/80859ed3b7afb1c527a2a99d70c61457bea72d0c)
by Sergii “iOrange” Kudlai, under its MIT option. The rest of the importer does not depend on it. The embedded module
decodes one row of BC7 blocks per call, so its scratch memory does not grow with texture height. It needs no network
or GPU compression support at runtime.

To regenerate, place `bcdec.h` from the pinned revision in an include directory and compile this folder’s `bc7.c`:

```sh
clang --target=wasm32 -Oz -nostdlib -fvisibility=hidden -I <include-directory> \
  -Wl,--no-entry -Wl,--export-memory -Wl,--export=__heap_base -Wl,--strip-all \
  bc7.c -o bc7.wasm
base64 -w 100 bc7.wasm
```

Replace the encoded string in `bc7-wasm.ts` with that output.

```text
MIT License

Copyright (c) 2022 Sergii Kudlai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
