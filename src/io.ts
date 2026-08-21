import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export interface ActionIO {
  getInput(name: string): string;
  addSecret(value: string): void;
  setOutput(name: string, value: string): void;
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  writeSummary(markdown: string): void;
  env: NodeJS.ProcessEnv;
}

function commandValue(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export class GitHubActionIO implements ActionIO {
  public constructor(public readonly env: NodeJS.ProcessEnv) {}

  public getInput(name: string): string {
    return (this.env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] ?? '').trim();
  }

  public addSecret(value: string): void {
    if (value) process.stdout.write(`::add-mask::${commandValue(value)}\n`);
  }

  public setOutput(name: string, value: string): void {
    const outputFile = this.env.GITHUB_OUTPUT;
    if (!outputFile) {
      this.warning(`GITHUB_OUTPUT is unavailable; output ${name} was not persisted.`);
      return;
    }
    const delimiter = `lexia_${randomUUID()}`;
    appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, { encoding: 'utf8' });
  }

  public info(message: string): void {
    process.stdout.write(`${commandValue(message)}\n`);
  }

  public warning(message: string): void {
    process.stdout.write(`::warning::${commandValue(message)}\n`);
  }

  public setFailed(message: string): void {
    process.exitCode = 1;
    process.stdout.write(`::error::${commandValue(message)}\n`);
  }

  public writeSummary(markdown: string): void {
    const summaryFile = this.env.GITHUB_STEP_SUMMARY;
    if (summaryFile) appendFileSync(summaryFile, markdown, { encoding: 'utf8' });
  }
}
