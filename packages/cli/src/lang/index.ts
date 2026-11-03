import type { LanguageSpec } from './spec.ts';
import { csharp } from './csharp.ts';
import { javascript, tsx, typescript } from './javascript.ts';
import { java, kotlin, scala } from './jvm.ts';
import { python } from './python.ts';
import { php, ruby } from './scripting.ts';
import { swift } from './swift.ts';
import { c, cpp, go, rust } from './systems.ts';

/** Every supported language. To add one, write a spec in this folder and list it here. */
export const LANGUAGES: LanguageSpec[] = [typescript, tsx, javascript, python, java, kotlin, scala, csharp, go, rust, c, cpp, swift, ruby, php];

const byExtension = new Map<string, LanguageSpec>();
for (const spec of LANGUAGES) {
  for (const ext of spec.extensions) {
    if (byExtension.has(ext)) throw new Error(`Extension ${ext} is claimed by both ${byExtension.get(ext)!.id} and ${spec.id}`);
    byExtension.set(ext, spec);
  }
}
const byId = new Map(LANGUAGES.map((s) => [s.id, s]));

export function specForPath(path: string): LanguageSpec | null {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const spec = dot === -1 ? undefined : byExtension.get(base.slice(dot).toLowerCase());
  if (!spec || spec.exclude?.test(path)) return null;
  return spec;
}

export function specForId(id: string): LanguageSpec | undefined {
  return byId.get(id);
}

export type { LanguageSpec } from './spec.ts';
