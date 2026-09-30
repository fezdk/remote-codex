import { readFileSync } from 'node:fs';
export const imageBytes = readFileSync(new URL('./fixtures/image-demo.png', import.meta.url));
export const imageData = `data:image/png;base64,${imageBytes.toString('base64')}`;
