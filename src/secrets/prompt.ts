import readline from 'node:readline';

export async function readSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    const originalWrite = (rl as any)._writeToOutput;
    output.write(prompt);
    (rl as any)._writeToOutput = function mutedWrite(stringToWrite: string) {
      if (stringToWrite.includes('\n') || stringToWrite.includes('\r')) {
        originalWrite.call(rl, stringToWrite);
      } else {
        originalWrite.call(rl, '*');
      }
    };
    rl.question('', (answer) => {
      rl.close();
      output.write('\n');
      resolve(answer.trim());
    });
  });
}
