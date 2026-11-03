import type { SinkCategory } from '../types.ts';
import type { ImportTarget, SyntaxNode } from './spec.ts';

/** `['com','acme','Money']` → `['com/acme/Money', 'acme/Money', 'Money']` (most specific first). */
export function trailingPaths(segments: string[]): string[] {
  return segments.map((_, i) => segments.slice(i).join('/')).filter(Boolean);
}

/** Java / Kotlin / Scala / C# style dotted imports, with `*` / `_` wildcards meaning a package. */
export function dottedImport(source: string, separator: string | RegExp = '.'): ImportTarget {
  const segs = source.split(separator).filter(Boolean);
  const last = segs.at(-1);
  if (last === '*' || last === '_' || last === '{') return { dirSuffixes: trailingPaths(segs.slice(0, -1)) };
  return { suffixes: trailingPaths(segs), dirSuffixes: trailingPaths(segs) };
}

/** Visibility / modifier keywords attached to a declaration, as one string. */
export function modifiers(fn: SyntaxNode): string {
  return fn.namedChildren
    .filter((c) => /modifier|visibility|storage_class|attribute_specifier/.test(c.type))
    .map((c) => c.text)
    .join(' ');
}

export const hasWord = (text: string, ...words: string[]) => words.some((w) => new RegExp(`\\b${w}\\b`).test(text));

/** Effectful packages in the JVM ecosystem (shared by Java, Kotlin and Scala). */
export const JVM_SINKS: Partial<Record<SinkCategory, RegExp>> = {
  database: /^(java\.sql|javax\.sql|javax\.persistence|jakarta\.persistence|org\.hibernate|org\.springframework\.jdbc|org\.springframework\.data\.(jpa|mongodb|jdbc)|org\.jooq|com\.mongodb|software\.amazon\.awssdk\.services\.dynamodb|com\.amazonaws\.services\.dynamodbv2|org\.jetbrains\.exposed|slick|doobie|io\.r2dbc)/,
  cache: /^(redis\.clients|io\.lettuce|org\.springframework\.data\.redis|org\.redisson|net\.spy\.memcached)/,
  network: /^(java\.net|okhttp3|org\.apache\.http|org\.apache\.hc|retrofit2|org\.springframework\.web\.client|org\.springframework\.web\.reactive\.function\.client|io\.grpc|feign|io\.ktor\.client|sttp|akka\.http)/,
  storage: /^(software\.amazon\.awssdk\.services\.s3|com\.amazonaws\.services\.s3|com\.google\.cloud\.storage|com\.azure\.storage)/,
  queue: /^(org\.apache\.kafka|org\.springframework\.kafka|javax\.jms|jakarta\.jms|software\.amazon\.awssdk\.services\.(sqs|sns|kinesis|eventbridge)|com\.amazonaws\.services\.(sqs|sns|kinesis)|com\.rabbitmq|com\.google\.cloud\.pubsub)/,
  filesystem: /^(java\.nio\.file|java\.io\.(File|FileWriter|FileReader|FileInputStream|FileOutputStream|RandomAccessFile))/,
  process: /^java\.lang\.(ProcessBuilder|Runtime)/,
};

export const JVM_TEST_FILE = /(^|\/)src\/test\/|Tests?\.(java|kt|scala)$|IT\.(java|kt)$|Spec\.(scala|kt)$/;
