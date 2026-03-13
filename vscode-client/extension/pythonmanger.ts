import { spawn, spawnSync } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { CONFIG_SECTION } from "./config";
import { PythonExtension, ActiveEnvironmentPathChangeEvent } from "@vscode/python-extension";

const UNKNOWN = "unknown";
const CUSTOM = "custom";

export interface ActivePythonEnvironmentChangedEvent {
  readonly resource: vscode.WorkspaceFolder | undefined;
}

export class PythonInfo {
  constructor(
    public readonly name: string,
    public readonly type: string | undefined,
    public readonly version: string,
    public readonly path?: string,
  ) {}
}
export class PythonManager {
  public get pythonLanguageServerMain(): string {
    return this._pythonLanguageServerMain;
  }

  public get robotCodeMain(): string {
    return this._robotCodeMain;
  }

  public get checkRobotVersionMain(): string {
    return this._checkRobotVersionMain;
  }

  public get checkPythonVersionScript(): string {
    return this._pythonVersionScript;
  }

  private readonly _onActivePythonEnvironmentChangedEmitter =
    new vscode.EventEmitter<ActivePythonEnvironmentChangedEvent>();
  public get onActivePythonEnvironmentChanged(): vscode.Event<ActivePythonEnvironmentChangedEvent> {
    return this._onActivePythonEnvironmentChangedEmitter.event;
  }

  _pythonLanguageServerMain: string;
  _checkRobotVersionMain: string;
  _robotCodeMain: string;
  _pythonVersionScript = "import sys; print(sys.version_info[:2]>=(3,8))";

  _pythonExtension: PythonExtension | undefined;
  private _disposables: vscode.Disposable | undefined;

  constructor(
    public readonly extensionContext: vscode.ExtensionContext,
    public readonly outputChannel: vscode.OutputChannel,
  ) {
    this._pythonLanguageServerMain = this.extensionContext.asAbsolutePath(
      path.join("bundled", "tool", "language_server"),
    );

    this._checkRobotVersionMain = this.extensionContext.asAbsolutePath(
      path.join("bundled", "tool", "utils", "check_robot_version.py"),
    );

    this._robotCodeMain = this.extensionContext.asAbsolutePath(path.join("bundled", "tool", "robotcode"));
  }

  dispose(): void {
    if (this._disposables !== undefined) this._disposables.dispose();
  }

  private doActiveEnvironmentPathChanged(event: ActiveEnvironmentPathChangeEvent): void {
    const wsFolder =
      event.resource === undefined
        ? undefined
        : event.resource instanceof vscode.Uri
          ? vscode.workspace.getWorkspaceFolder(event.resource)
          : event.resource;

    this.outputChannel.appendLine(`ActiveEnvironmentPathChanged: ${wsFolder?.uri ?? UNKNOWN} ${event.id}`);

    this._onActivePythonEnvironmentChangedEmitter.fire({ resource: wsFolder });
  }

  async getPythonExtension(): Promise<PythonExtension | undefined> {
    if (this._pythonExtension === undefined) {
      this.outputChannel.appendLine("Try to activate python extension");

      try {
        this._pythonExtension = await PythonExtension.api();

        this.outputChannel.appendLine("Python Extension is active");
        await this._pythonExtension.ready;
      } catch (ex: unknown) {
        this.outputChannel.appendLine(`can't activate python extension ${ex?.toString() ?? ""}`);
      }

      if (this._pythonExtension !== undefined) {
        this._disposables = vscode.Disposable.from(
          this._pythonExtension.environments.onDidChangeActiveEnvironmentPath((event) =>
            this.doActiveEnvironmentPathChanged(event),
          ),
        );
      }
    }
    return this._pythonExtension;
  }

  public async getPythonCommand(folder: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder);
    let result: string | undefined;

    const configPython = config.get<string>("python");

    if (configPython !== undefined && configPython !== "") {
      result = configPython;
    } else {
      const pythonExtension = await this.getPythonExtension();

      const environmentPath = pythonExtension?.environments.getActiveEnvironmentPath(folder);
      if (environmentPath === undefined) {
        return undefined;
      }

      const env = await pythonExtension?.environments.resolveEnvironment(environmentPath);
      result = env?.executable.uri?.fsPath;
    }

    return result;
  }

  public checkPythonVersion(pythonCommand: string): boolean {
    const res = spawnSync(pythonCommand, ["-u", "-c", this.checkPythonVersionScript], {
      encoding: "ascii",
    });
    if (res.status == 0 && res.stdout && res.stdout.trimEnd() === "True") return true;

    return false;
  }

  public checkRobotVersion(pythonCommand: string): boolean | undefined {
    const res = spawnSync(pythonCommand, ["-u", this.checkRobotVersionMain], {
      encoding: "ascii",
    });

    if (res.status == 0 && res.stdout && res.stdout.trimEnd() === "True") return true;

    const stdout = res.stdout;
    if (stdout) this.outputChannel.appendLine(`checkRobotVersion: ${stdout}`);
    const stderr = res.stderr;
    if (stderr) this.outputChannel.appendLine(`checkRobotVersion: ${stderr}`);

    if (res.status != 0) return undefined;

    return false;
  }

  public async getDebuggerPackagePath(): Promise<string | undefined> {
    // TODO: this is not enabled in debugpy extension yet
    const debugpy = vscode.extensions.getExtension("ms-python.debugpy");
    if (debugpy !== undefined) {
      if (!debugpy.isActive) {
        await debugpy.activate();
      }
      const path = (debugpy.exports as PythonExtension)?.debug.getDebuggerPackagePath();
      if (path !== undefined) {
        return path;
      }
    }
    return (await this.getPythonExtension())?.debug.getDebuggerPackagePath();
  }

  public async executeRobotCode(
    folder: vscode.WorkspaceFolder,
    args: string[],
    profiles?: string[],
    format?: string,
    noColor?: boolean,
    noPager?: boolean,
    stdioData?: string,
    token?: vscode.CancellationToken,
  ): Promise<unknown> {
    const { pythonCommand, final_args } = await this.buildRobotCodeCommand(
      folder,
      args,
      profiles,
      format,
      noColor,
      noPager,
    );

    this.outputChannel.appendLine(`executeRobotCode: cwd=${folder.uri.fsPath}`);
    this.outputChannel.appendLine(`executeRobotCode: command=${pythonCommand}`);
    this.outputChannel.appendLine(`executeRobotCode: args=${JSON.stringify(final_args)}`);

    return new Promise((resolve, reject) => {
      const abortController = new AbortController();

      token?.onCancellationRequested(() => {
        abortController.abort();
      });

      const { signal } = abortController;

      const process = spawn(pythonCommand, final_args, {
        cwd: folder.uri.fsPath,

        signal,
      });

      let stdout = "";
      let stderr = "";

      process.stdout.setEncoding("utf8");
      process.stderr.setEncoding("utf8");
      if (stdioData !== undefined) {
        process.stdin.cork();
        process.stdin.write(stdioData, "utf8");
        process.stdin.end();
      }

      process.stdout.on("data", (data) => {
        stdout += data;
        // this.outputChannel.appendLine(data as string);
      });

      process.stderr.on("data", (data) => {
        stderr += data;
        this.outputChannel.appendLine(data as string);
      });

      process.on("error", (err) => {
        reject(err);
      });

      process.on("exit", (code) => {
        this.outputChannel.appendLine(`executeRobotCode: exit code ${code ?? "null"}`);
        if (code === 0) {
          try {
            resolve(this.parseJsonOutput(stdout));
          } catch (err) {
            const head = stdout.slice(0, 1000);
            const tail = stdout.slice(-1000);
            this.outputChannel.appendLine(
              `executeRobotCode: invalid json output length=${stdout.length} head:\n${head}\n...tail:\n${tail}`,
            );
            reject(err);
          }
        } else {
          this.outputChannel.appendLine(`executeRobotCode: ${stdout}\n${stderr}`);

          reject(new Error(`Executing robotcode failed with code ${code ?? "null"}: ${stdout}\n${stderr}`));
        }
      });
    });
  }

  // eslint-disable-next-line class-methods-use-this
  private parseJsonOutput(stdout: string): unknown {
    const text = stdout
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
      .replace(/\u0000/g, "")
      .trim();
    if (!text) {
      throw new Error("Executing robotcode failed: empty json output.");
    }

    try {
      return JSON.parse(text);
    } catch {
      const starts: number[] = [];
      let bestParsedValue: unknown | undefined;
      let bestParsedLength = -1;
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === "{" || text[i] === "[") {
          starts.push(i);
        }
      }

      for (const start of starts) {
        const stack: string[] = [];
        let inString = false;
        let escaped = false;
        let parsedValue: unknown | undefined;
        for (let i = start; i < text.length; i += 1) {
          const ch = text[i];
          if (inString) {
            if (escaped) {
              escaped = false;
            } else if (ch === "\\") {
              escaped = true;
            } else if (ch === '"') {
              inString = false;
            }
            continue;
          }

          if (ch === '"') {
            inString = true;
            continue;
          }
          if (ch === "{") {
            stack.push("}");
            continue;
          }
          if (ch === "[") {
            stack.push("]");
            continue;
          }
          if (ch === "}" || ch === "]") {
            if (stack.length === 0) break;
            const expected = stack.pop();
            if (expected !== ch) break;
            if (stack.length === 0) {
              const candidate = text.slice(start, i + 1);
              try {
                parsedValue = JSON.parse(candidate);
              } catch {
                parsedValue = undefined;
              }
              if (parsedValue !== undefined) {
                const remaining = text.slice(i + 1).trim();
                if (remaining.length === 0) {
                  return parsedValue;
                }
                if (candidate.length > bestParsedLength) {
                  bestParsedValue = parsedValue;
                  bestParsedLength = candidate.length;
                }
              }
              continue;
            }
          }
        }
      }

      if (bestParsedValue !== undefined) {
        return bestParsedValue;
      }

      const sample = text.slice(0, 500);
      throw new Error(`Executing robotcode failed: output did not contain parseable JSON. Sample: ${sample}`);
    }
  }

  public async buildRobotCodeCommand(
    folder: vscode.WorkspaceFolder,
    args: string[],
    profiles?: string[],
    format?: string,
    noColor?: boolean,
    noPager?: boolean,
  ): Promise<{ pythonCommand: string; final_args: string[] }> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder);
    const robotCodeExtraArgs = config.get<string[]>("extraArgs", []);

    const pythonCommand = await this.getPythonCommand(folder);
    if (pythonCommand === undefined) throw new Error("Can't find python executable.");

    const final_args = [
      "-u",
      "-X",
      "utf8",
      this.robotCodeMain,
      ...robotCodeExtraArgs,
      ...(format ? ["--format", format] : []),
      ...(noColor ? ["--no-color"] : []),
      ...(noPager ? ["--no-pager"] : []),
      ...(profiles !== undefined ? profiles.flatMap((v) => ["-p", v]) : []),
      ...args,
    ];
    return { pythonCommand, final_args };
  }

  async getPythonInfo(folder: vscode.WorkspaceFolder): Promise<PythonInfo | undefined> {
    try {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION, folder);
      let name: string | undefined;
      let type: string | undefined;
      let path: string | undefined;
      let version: string | undefined;

      const configPython = config.get<string>("python");

      if (configPython !== undefined && configPython !== "") {
        path = configPython;
      } else {
        const pythonExtension = await this.getPythonExtension();

        const environmentPath = pythonExtension?.environments.getActiveEnvironmentPath(folder);
        if (environmentPath === undefined) {
          return undefined;
        }

        const env = await pythonExtension?.environments.resolveEnvironment(environmentPath);
        path = env?.executable.uri?.fsPath;
        version =
          env?.version !== undefined ? `${env.version.major}.${env.version.minor}.${env.version.micro}` : undefined;
        if (env?.environment !== undefined) {
          type = env?.tools?.[0];
          name = `('${env?.environment?.name ?? UNKNOWN}': ${type ?? UNKNOWN})`;
        } else {
          name = env?.executable.bitness ?? UNKNOWN;
        }
      }

      return new PythonInfo(name ?? CUSTOM, type, version ?? UNKNOWN, path);
    } catch {
      return undefined;
    }
  }
}
