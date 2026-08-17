import type { Foo } from '@scope/pkgb/src/lib.ts'
import type { Baz } from './other.ts'
export const y: Foo = { x: 1, baz: { z: 'a' } }
export const b: Baz = { z: 'b' }
