/** Plain line logging. Demo output is meant to be read by a person. */
export function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function step(title: string): void {
  log(`\n== ${title}`);
}
