import ts from 'typescript';

const OWNER_ALIASES = new Map<string, readonly string[]>([
  ['globalThis', ['Window']],
  ['ReadonlyArray', ['Array']],
  ['ReadonlyMap', ['Map']],
  ['ReadonlySet', ['Set']],
  ['IteratorObject', ['Iterator']],
  ['ArrayIterator', ['Iterator']],
  ['MapIterator', ['Iterator']],
  ['SetIterator', ['Iterator']],
  ['StringIterator', ['Iterator']],
  ['RegExpStringIterator', ['Iterator']],
  ['AsyncIteratorObject', ['AsyncIterator']],
  ['Int8Array', ['Int8Array', 'TypedArray']],
  ['Uint8Array', ['Uint8Array', 'TypedArray']],
  ['Uint8ClampedArray', ['Uint8ClampedArray', 'TypedArray']],
  ['Int16Array', ['Int16Array', 'TypedArray']],
  ['Uint16Array', ['Uint16Array', 'TypedArray']],
  ['Int32Array', ['Int32Array', 'TypedArray']],
  ['Uint32Array', ['Uint32Array', 'TypedArray']],
  ['Float16Array', ['Float16Array', 'TypedArray']],
  ['Float32Array', ['Float32Array', 'TypedArray']],
  ['Float64Array', ['Float64Array', 'TypedArray']],
  ['BigInt64Array', ['BigInt64Array', 'TypedArray']],
  ['BigUint64Array', ['BigUint64Array', 'TypedArray']],
]);

export function isLibraryDeclaration(program: ts.Program, declaration: ts.Declaration): boolean {
  const sourceFile = declaration.getSourceFile();
  return (
    program.isSourceFileDefaultLibrary(sourceFile) ||
    sourceFile.fileName.includes('/node_modules/@types/node/')
  );
}

function enclosingStatement(declaration: ts.Declaration): ts.Node {
  return ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
}

function enclosingNamespace(declaration: ts.Declaration): string | undefined {
  const container = enclosingStatement(declaration).parent;
  if (!ts.isModuleBlock(container)) {
    return undefined;
  }
  const name = container.parent.name.getText();
  return name === 'global' ? undefined : name;
}

function isGlobalDeclaration(declaration: ts.Declaration): boolean {
  const isValue =
    ts.isVariableDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isClassDeclaration(declaration) ||
    ts.isModuleDeclaration(declaration);
  const container = enclosingStatement(declaration).parent;
  return (
    isValue &&
    (ts.isSourceFile(container) ||
      (ts.isModuleBlock(container) && container.parent.name.getText() === 'global'))
  );
}

function isAmbient(declaration: ts.Declaration): boolean {
  if (declaration.getSourceFile().isDeclarationFile) {
    return true;
  }
  for (let node: ts.Node = declaration; !ts.isSourceFile(node); node = node.parent) {
    const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) {
      return true;
    }
  }
  return false;
}

export function isGlobalLibrarySymbol(program: ts.Program, symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.declarations ?? [];
  const isImplementedByUser = declarations.some(
    (declaration) => !isLibraryDeclaration(program, declaration) && !isAmbient(declaration),
  );
  return (
    !isImplementedByUser &&
    declarations.some(
      (declaration) =>
        isLibraryDeclaration(program, declaration) && isGlobalDeclaration(declaration),
    )
  );
}

export function globalKeys(name: string, isConstructed: boolean): string[] {
  return [
    ...(isConstructed ? [`api.${name}.${name}`, `javascript.builtins.${name}.${name}`] : []),
    `api.${name}`,
    `api.Window.${name}`,
    `javascript.builtins.${name}`,
  ];
}

export function instanceKeys(owners: readonly string[], name: string): string[] {
  return owners.flatMap((owner) =>
    (OWNER_ALIASES.get(owner) ?? [owner]).flatMap((alias) => [
      `javascript.builtins.${alias}.${name}`,
      `api.${alias}.${name}`,
      ...(name.startsWith('on') ? [`api.${alias}.${name.slice(2)}_event`] : []),
    ]),
  );
}

export function staticKeys(owner: string, name: string): string[] {
  return [`api.${owner}.${name}_static`, `javascript.builtins.${owner}.${name}`];
}

function namespaceKeys(namespace: string, name: string, isConstructed: boolean): string[] {
  if (namespace === 'WebAssembly') {
    return [
      ...(isConstructed ? [`webassembly.api.${name}.${name}`] : []),
      `webassembly.api.${name}_static`,
      `webassembly.api.${name}`,
    ];
  }
  return [
    ...(isConstructed
      ? [`javascript.builtins.${namespace}.${name}.${name}`, `api.${namespace}.${name}.${name}`]
      : []),
    `api.${namespace}.${name}_static`,
    `api.${namespace}.${name}`,
    `javascript.builtins.${namespace}.${name}`,
  ];
}

function qualifiedName(name: string, declaration: ts.Declaration): string {
  const namespace = enclosingNamespace(declaration);
  return namespace === undefined ? name : `${namespace}.${name}`;
}

function declarationKeys(
  declaration: ts.Declaration,
  name: string,
  isConstructed: boolean,
): string[] {
  if (isGlobalDeclaration(declaration)) {
    return globalKeys(name, isConstructed);
  }
  const namespace = enclosingNamespace(declaration);
  if (namespace !== undefined) {
    return namespaceKeys(namespace, name, isConstructed);
  }
  const owner = declaration.parent;
  if (ts.isInterfaceDeclaration(owner) || ts.isClassDeclaration(owner)) {
    const ownerName = qualifiedName(owner.name?.text ?? '', owner);
    if (ownerName.endsWith('Constructor') && ownerName !== 'Constructor') {
      return staticKeys(ownerName.slice(0, -'Constructor'.length), name);
    }
    if (ownerName === 'Console') {
      return staticKeys('console', name);
    }
    const isStatic =
      ts.canHaveModifiers(declaration) &&
      (ts.getModifiers(declaration) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
      );
    if (isStatic) {
      return staticKeys(ownerName, name);
    }
    return instanceKeys([ownerName], name);
  }
  if (ts.isTypeLiteralNode(owner) && ts.isVariableDeclaration(owner.parent)) {
    return staticKeys(qualifiedName(owner.parent.name.getText(), owner.parent), name);
  }
  return [];
}

export function typeNames(checker: ts.TypeChecker, type: ts.Type): string[] {
  const seen = new Set<ts.Type>();
  const collect = (current: ts.Type): string[] => {
    if (seen.has(current)) {
      return [];
    }
    seen.add(current);
    if (current.isUnionOrIntersection()) {
      return current.types.flatMap(collect);
    }
    const isTypeReference =
      (current.flags & ts.TypeFlags.Object) !== 0 &&
      ((current as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0;
    const target = isTypeReference ? (current as ts.TypeReference).target : current;
    const bases = target.isClassOrInterface() ? checker.getBaseTypes(target) : [];
    const isGlobalThis = checker.typeToString(current).startsWith('typeof globalThis');
    const symbolName = (current.aliasSymbol ?? current.getSymbol())?.getName();
    const name = isGlobalThis ? 'globalThis' : symbolName;
    return [
      ...(name === undefined || name.startsWith('__') ? [] : [name]),
      ...bases.flatMap(collect),
    ];
  };
  return collect(type);
}

export function eventKeys(owners: readonly string[], event: string): string[] {
  return owners.flatMap((owner) =>
    (OWNER_ALIASES.get(owner) ?? [owner]).map((alias) => `api.${alias}.${event}_event`),
  );
}

export function symbolKeys(
  program: ts.Program,
  symbol: ts.Symbol,
  name: string,
  isConstructed: boolean,
): string[] {
  return (symbol.declarations ?? [])
    .filter((declaration) => isLibraryDeclaration(program, declaration))
    .flatMap((declaration) => declarationKeys(declaration, name, isConstructed));
}
