import ts from 'typescript';
import { join } from 'node:path';

export interface TypecheckDiagnostic {
  message: string;
  line?: number;
}

/**
 * Typechecks the generated file in place, using the *target repo's own*
 * spec2test/tsconfig.json - not options invented here - so this proves the
 * file the real toolchain would see, not an idealised one.
 */
export function typecheckFile(filePath: string, tsconfigDir: string): TypecheckDiagnostic[] {
  const configPath = join(tsconfigDir, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    return [{ message: ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n') }];
  }

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, tsconfigDir);
  const program = ts.createProgram({ rootNames: [filePath], options: parsed.options });
  const sourceFile = program.getSourceFile(filePath);

  const diagnostics = [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)];

  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file && d.start !== undefined) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      return { message, line: line + 1 };
    }
    return { message };
  });
}
