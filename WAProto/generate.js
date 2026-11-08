import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const commands = [
	['pbjs', ['-t', 'static-module', '--sparse', '-w', 'esm', '-o', './index.js', './WAProto.proto']],
	['pbts', ['-o', './index.d.ts', './index.js']],
	[process.execPath, ['./fix-imports.js']]
]

for (const [command, args] of commands) {
	const windowsCli = process.platform === 'win32' && (command === 'pbjs' || command === 'pbts')
	const result = windowsCli
		? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], {
				cwd: directory,
				stdio: 'inherit'
			})
		: spawnSync(command, [...args], { cwd: directory, stdio: 'inherit' })
	if (result.error) throw result.error
	if (result.status !== 0) process.exit(result.status ?? 1)
}
