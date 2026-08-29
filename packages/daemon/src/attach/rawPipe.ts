export interface RawPipeSinks {
  onData: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

export interface RawPipeHandle {
  stop(): void;
}

// Puts the local terminal in raw mode and streams keystrokes + resize events
// to the sinks. Used by `rcmdsh attach` and by the daemon TUI's attach view so
// both share identical local-input behavior.
export function startRawPipe(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, sinks: RawPipeSinks): RawPipeHandle {
  const onData = (chunk: Buffer) => sinks.onData(chunk.toString("utf8"));
  const onResize = () => {
    if (stdout.columns && stdout.rows) {
      sinks.onResize(stdout.columns, stdout.rows);
    }
  };

  if (stdin.isTTY && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(true);
  }
  stdin.resume();
  stdin.on("data", onData);
  stdout.on("resize", onResize);
  onResize();

  return {
    stop(): void {
      stdin.removeListener("data", onData);
      stdout.removeListener("resize", onResize);
      if (stdin.isTTY && typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
    },
  };
}
