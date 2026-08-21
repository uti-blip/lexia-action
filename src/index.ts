import { runAction } from './action';
import { GitHubActionIO } from './io';

async function main(): Promise<void> {
  const io = new GitHubActionIO(process.env);
  try {
    await runAction(io);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lexia audit failed unexpectedly';
    io.setFailed(message);
  }
}

void main();
