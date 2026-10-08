import { AST_NODE_TYPES, ESLintUtils, type TSESTree } from '@typescript-eslint/utils';
import ts from 'typescript';

import { isGuarded, propertyName } from './guards.js';
import {
  eventKeys,
  globalKeys,
  instanceKeys,
  isGlobalLibrarySymbol,
  isLibraryDeclaration,
  staticKeys,
  symbolKeys,
  typeNames,
} from './keys.js';
import {
  describeTargets,
  existsInCompatData,
  findUnsupportedTargets,
  resolveTargets,
  type UnsupportedTarget,
} from './support.js';

type Options = [
  {
    browserslist?: string | string[];
    ignore?: string[];
    partialImplementation?: 'supported' | 'unsupported';
  },
];

type Finding = { key: string; unsupportedTargets: UnsupportedTarget[] };

const RUNTIME_TS_PARENTS = new Set<string>([
  AST_NODE_TYPES.TSAsExpression,
  AST_NODE_TYPES.TSSatisfiesExpression,
  AST_NODE_TYPES.TSNonNullExpression,
  AST_NODE_TYPES.TSTypeAssertion,
  AST_NODE_TYPES.TSInstantiationExpression,
  AST_NODE_TYPES.TSExportAssignment,
]);

function isValueReference(node: TSESTree.Identifier): boolean {
  const parent = node.parent;
  switch (parent.type) {
    case AST_NODE_TYPES.MemberExpression:
      return parent.object === node || parent.computed;
    case AST_NODE_TYPES.Property:
      return parent.value === node && parent.parent.type === AST_NODE_TYPES.ObjectExpression;
    case AST_NODE_TYPES.MethodDefinition:
    case AST_NODE_TYPES.PropertyDefinition:
    case AST_NODE_TYPES.AccessorProperty:
      return parent.value === node || (parent.computed && parent.key === node);
    case AST_NODE_TYPES.LabeledStatement:
    case AST_NODE_TYPES.BreakStatement:
    case AST_NODE_TYPES.ContinueStatement:
    case AST_NODE_TYPES.ImportSpecifier:
    case AST_NODE_TYPES.ImportDefaultSpecifier:
    case AST_NODE_TYPES.ImportNamespaceSpecifier:
    case AST_NODE_TYPES.ExportSpecifier:
      return false;
    default:
      return !parent.type.startsWith('TS') || RUNTIME_TS_PARENTS.has(parent.type);
  }
}

function memberName(node: TSESTree.MemberExpression): string | undefined {
  const name = propertyName(node);
  if (name !== undefined) {
    return name;
  }
  const property = node.property;
  if (
    node.computed &&
    property.type === AST_NODE_TYPES.MemberExpression &&
    property.object.type === AST_NODE_TYPES.Identifier &&
    property.object.name === 'Symbol' &&
    property.property.type === AST_NODE_TYPES.Identifier
  ) {
    return `@@${property.property.name}`;
  }
  return undefined;
}

const createRule = ESLintUtils.RuleCreator(
  () => 'https://github.com/sofuetakuma112/eslint-plugin-typed-compat#readme',
);

export const compat = createRule<Options, 'unsupported'>({
  name: 'compat',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow Web and JavaScript APIs that the browserslist targets do not support',
    },
    schema: [
      {
        type: 'object',
        properties: {
          browserslist: {
            description:
              'Browserslist queries. The config for the linted file is used when omitted.',
            oneOf: [
              { description: 'A query.', type: 'string' },
              { description: 'A list of queries.', type: 'array', items: { type: 'string' } },
            ],
          },
          ignore: {
            description: 'Keys of browser-compat-data to skip, including every key under them.',
            type: 'array',
            items: { type: 'string' },
          },
          partialImplementation: {
            description: 'Whether partial implementations count as supported.',
            type: 'string',
            enum: ['supported', 'unsupported'],
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{}],
    messages: {
      unsupported: '"{{key}}" is not supported in {{targets}}',
    },
  },
  create(context, [options]) {
    const services = ESLintUtils.getParserServices(context);
    const program = services.program;
    const checker = program.getTypeChecker();
    const targets = resolveTargets(options.browserslist, context.filename);
    const allowPartialImplementation = options.partialImplementation !== 'unsupported';
    const ignore = options.ignore ?? [];

    const evaluate = (keys: readonly string[]): Finding | undefined => {
      const key = keys.find(existsInCompatData);
      if (key === undefined) {
        return undefined;
      }
      const isIgnored = ignore.some((entry) => key === entry || key.startsWith(`${entry}.`));
      if (isIgnored) {
        return undefined;
      }
      const unsupportedTargets = findUnsupportedTargets(key, targets, allowPartialImplementation);
      return unsupportedTargets.length === 0 ? undefined : { key, unsupportedTargets };
    };

    const ownersOf = (node: TSESTree.Node): string[] => {
      const type = services.getTypeAtLocation(node);
      if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
        return [];
      }
      return [...new Set(typeNames(checker, checker.getApparentType(type)))];
    };

    const identifierSymbol = (node: TSESTree.Identifier): ts.Symbol | undefined => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return ts.isShorthandPropertyAssignment(tsNode.parent)
        ? checker.getShorthandAssignmentValueSymbol(tsNode.parent)
        : checker.getSymbolAtLocation(tsNode);
    };

    const isConstructed = (node: TSESTree.Node): boolean =>
      node.parent?.type === AST_NODE_TYPES.NewExpression && node.parent.callee === node;

    const globalName = (node: TSESTree.Node): string | undefined => {
      if (node.type === AST_NODE_TYPES.Identifier) {
        const symbol = identifierSymbol(node);
        if (symbol !== undefined && !isGlobalLibrarySymbol(program, symbol)) {
          return undefined;
        }
        return node.name;
      }
      if (node.type !== AST_NODE_TYPES.MemberExpression) {
        return undefined;
      }
      const name = propertyName(node);
      const isGlobal = isGlobalLibrarySymbol(program, services.getSymbolAtLocation(node.property));
      if (name === undefined || !isGlobal) {
        return undefined;
      }
      return name;
    };

    const evaluateIdentifier = (node: TSESTree.Identifier): Finding | undefined => {
      const symbol = identifierSymbol(node);
      if (symbol !== undefined && !isGlobalLibrarySymbol(program, symbol)) {
        return undefined;
      }
      return evaluate(globalKeys(node.name, isConstructed(node)));
    };

    const evaluateProperty = (
      node: TSESTree.Node,
      receiver: TSESTree.Node,
      name: string,
      symbol: ts.Symbol | undefined,
    ): Finding | undefined => {
      const owners = ownersOf(receiver);
      if (symbol !== undefined) {
        const isFromLibrary = (symbol.declarations ?? []).some((declaration) =>
          isLibraryDeclaration(program, declaration),
        );
        return isFromLibrary
          ? evaluate([
              ...symbolKeys(program, symbol, name, isConstructed(node)),
              ...instanceKeys(owners, name),
            ])
          : undefined;
      }
      const receiverGlobal = globalName(receiver);
      return evaluate([
        ...(receiverGlobal === undefined ? [] : staticKeys(receiverGlobal, name)),
        ...instanceKeys(owners, name),
      ]);
    };

    const evaluateMember = (node: TSESTree.MemberExpression): Finding | undefined => {
      const name = memberName(node);
      if (name === undefined || node.object.type === AST_NODE_TYPES.Super) {
        return undefined;
      }
      const symbol = name.startsWith('@@')
        ? undefined
        : services.getSymbolAtLocation(node.property);
      return evaluateProperty(node, node.object, name, symbol);
    };

    const report = (node: TSESTree.Node, finding: Finding) => {
      context.report({
        node,
        messageId: 'unsupported',
        data: { key: finding.key, targets: describeTargets(finding.unsupportedTargets) },
      });
    };

    return {
      Identifier(node) {
        if (!isValueReference(node)) {
          return;
        }
        const finding = evaluateIdentifier(node);
        if (finding !== undefined && !isGuarded(node, node.name, services)) {
          report(node, finding);
        }
      },
      MemberExpression(node) {
        const finding = evaluateMember(node);
        if (finding === undefined || isGuarded(node, memberName(node) ?? '', services)) {
          return;
        }
        const receiver = node.object;
        let receiverFinding: Finding | undefined;
        if (receiver.type === AST_NODE_TYPES.Identifier) {
          receiverFinding = evaluateIdentifier(receiver);
        }
        if (receiver.type === AST_NODE_TYPES.MemberExpression) {
          receiverFinding = evaluateMember(receiver);
        }
        const isExplainedByReceiver =
          receiverFinding !== undefined &&
          finding.unsupportedTargets.every(({ browser }) =>
            receiverFinding.unsupportedTargets.some((target) => target.browser === browser),
          );
        if (!isExplainedByReceiver) {
          report(node, finding);
        }
      },
      'VariableDeclarator > ObjectPattern > Property'(node: TSESTree.Property) {
        const declarator = node.parent.parent;
        if (
          node.computed ||
          node.key.type !== AST_NODE_TYPES.Identifier ||
          declarator.type !== AST_NODE_TYPES.VariableDeclarator ||
          declarator.init === null
        ) {
          return;
        }
        const name = node.key.name;
        const receiverType = checker.getApparentType(services.getTypeAtLocation(declarator.init));
        const finding = evaluateProperty(
          node.key,
          declarator.init,
          name,
          checker.getPropertyOfType(receiverType, name),
        );
        if (finding !== undefined && !isGuarded(node, name, services)) {
          report(node.key, finding);
        }
      },
      CallExpression(node) {
        const [event] = node.arguments;
        const callee = node.callee;
        const isAddEventListener =
          (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'addEventListener') ||
          (callee.type === AST_NODE_TYPES.MemberExpression &&
            propertyName(callee) === 'addEventListener');
        if (
          !isAddEventListener ||
          event?.type !== AST_NODE_TYPES.Literal ||
          typeof event.value !== 'string'
        ) {
          return;
        }
        const owners =
          callee.type === AST_NODE_TYPES.MemberExpression ? ownersOf(callee.object) : ['Window'];
        const finding = evaluate(eventKeys(owners, event.value));
        if (finding !== undefined && !isGuarded(event, `on${event.value}`, services)) {
          report(event, finding);
        }
      },
    };
  },
});
