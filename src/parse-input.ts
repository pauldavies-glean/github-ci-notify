export type ParsedRunInput =
  | { kind: 'with-repo'; repo: string; runId: number }
  | { kind: 'raw-id'; runId: number };

export function parseRunInput(input: string): ParsedRunInput | null {
  const s = input.trim();
  if (!s) return null;

  // URL forms:
  //   https://github.com/owner/repo/actions/runs/12345
  //   https://github.com/owner/repo/actions/runs/12345/job/67890
  //   https://github.com/owner/repo/actions/runs/12345/attempts/2
  const urlMatch = s.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)/
  );
  if (urlMatch) {
    return {
      kind: 'with-repo',
      repo: `${urlMatch[1]}/${urlMatch[2]}`,
      runId: parseInt(urlMatch[3], 10),
    };
  }

  // Raw numeric run id
  if (/^\d+$/.test(s)) {
    return { kind: 'raw-id', runId: parseInt(s, 10) };
  }

  return null;
}
