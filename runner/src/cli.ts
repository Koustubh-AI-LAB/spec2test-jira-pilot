import { initTargetRepo } from './init.ts';

const [command, targetPath] = process.argv.slice(2);

if (command === 'init' && targetPath) {
  initTargetRepo(targetPath);
  console.log(`spec2test/ scaffolded in ${targetPath}`);
} else {
  console.error('usage: runner init <target-repo-path>');
  process.exit(1);
}
