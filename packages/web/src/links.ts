import type { CodeGraph } from './data.ts';

export interface CodeLinks {
  /** The lines on GitHub / GitLab / Bitbucket at the graph's commit. */
  web?: string;
  webLabel?: string;
  /** Opens the local file at the line in VS Code. */
  editor: string;
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Links to a file, or to a line range within it. */
export function codeLinks(graph: CodeGraph, file: string, lines?: { startLine: number; endLine: number }): CodeLinks {
  const r = graph.meta.remote;
  const path = encodePath(file);
  let web: string | undefined;
  if (r) {
    const s = lines?.startLine;
    const e = lines?.endLine;
    if (r.host === 'gitlab') web = `${r.web}/-/blob/${r.commit}/${path}${s ? `#L${s}-${e}` : ''}`;
    else if (r.host === 'bitbucket') web = `${r.web}/src/${r.commit}/${path}${s ? `#lines-${s}:${e}` : ''}`;
    // GitHub's layout, which most other hosts (Gitea, Forgejo, GitHub Enterprise) also follow.
    else web = `${r.web}/blob/${r.commit}/${path}${s ? `#L${s}-L${e}` : ''}`;
  }
  const host = r ? ({ github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', other: new URL(r.web).hostname } as const)[r.host] : undefined;
  return {
    web,
    webLabel: host ? `View on ${host}` : undefined,
    editor: `vscode://file${encodeURI(`${graph.meta.repo}/${file}`)}${lines ? `:${lines.startLine}` : ''}`,
  };
}
