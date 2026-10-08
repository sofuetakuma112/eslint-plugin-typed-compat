import type { ParserServicesWithTypeInformation, TSESTree } from '@typescript-eslint/utils';
import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import ts from 'typescript';

import { isLibraryDeclaration } from './keys.js';

const MAX_VARIABLE_DEPTH = 3;

function unwrap(node: TSESTree.Node): TSESTree.Node {
  if (
    node.type === AST_NODE_TYPES.ChainExpression ||
    node.type === AST_NODE_TYPES.TSNonNullExpression ||
    node.type === AST_NODE_TYPES.TSAsExpression ||
    node.type === AST_NODE_TYPES.TSSatisfiesExpression
  ) {
    return unwrap(node.expression);
  }
  return node;
}

function stringValue(node: TSESTree.Node): string | undefined {
  if (node.type === AST_NODE_TYPES.Literal && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === AST_NODE_TYPES.TemplateLiteral && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

export function propertyName(node: TSESTree.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === AST_NODE_TYPES.Identifier) {
    return node.property.name;
  }
  return node.computed ? stringValue(node.property) : undefined;
}

function isNullish(node: TSESTree.Node): boolean {
  return (
    (node.type === AST_NODE_TYPES.Literal && node.value === null) ||
    (node.type === AST_NODE_TYPES.Identifier && node.name === 'undefined')
  );
}

function hasNullableType(
  node: TSESTree.Node,
  services: ParserServicesWithTypeInformation,
): boolean {
  const expression = unwrap(node);
  const reference =
    expression.type === AST_NODE_TYPES.MemberExpression ? expression.property : expression;
  const symbol = services.getSymbolAtLocation(reference);
  const type =
    symbol === undefined
      ? services.getTypeAtLocation(expression)
      : services.program.getTypeChecker().getTypeOfSymbol(symbol);
  return (type.isUnion() ? type.types : [type]).some(
    (part) => (part.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0,
  );
}

function isNamedReference(
  node: TSESTree.Node,
  name: string,
  services: ParserServicesWithTypeInformation,
): boolean {
  const expression = unwrap(node);
  if (expression.type === AST_NODE_TYPES.MemberExpression) {
    return propertyName(expression) === name;
  }
  if (expression.type !== AST_NODE_TYPES.Identifier || expression.name !== name) {
    return false;
  }
  const declarations = services.getSymbolAtLocation(expression)?.declarations ?? [];
  const isLocal =
    declarations.length > 0 &&
    !declarations.some((declaration) => isLibraryDeclaration(services.program, declaration));
  return !isLocal;
}

function isPresenceReference(
  node: TSESTree.Node,
  name: string,
  services: ParserServicesWithTypeInformation,
): boolean {
  return isNamedReference(node, name, services) && !hasNullableType(node, services);
}

type GuardContext = {
  services: ParserServicesWithTypeInformation;
  depth: number;
};

function constantInitializer(
  node: TSESTree.Identifier,
  context: GuardContext,
): TSESTree.Node | undefined {
  const declaration = context.services.getSymbolAtLocation(node)?.valueDeclaration;
  if (
    declaration === undefined ||
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
  ) {
    return undefined;
  }
  return context.services.tsNodeToESTreeNodeMap.get(declaration.initializer);
}

function equalityOf(node: TSESTree.BinaryExpression): 'equal' | 'notEqual' | undefined {
  if (node.operator === '===' || node.operator === '==') {
    return 'equal';
  }
  if (node.operator === '!==' || node.operator === '!=') {
    return 'notEqual';
  }
  return undefined;
}

function typeofComparison(
  node: TSESTree.BinaryExpression,
): { operand: TSESTree.Node; type: string; isEqual: boolean } | undefined {
  const equality = equalityOf(node);
  if (equality === undefined) {
    return undefined;
  }
  for (const [left, right] of [
    [node.left, node.right],
    [node.right, node.left],
  ] as const) {
    const type = stringValue(right);
    if (
      left.type === AST_NODE_TYPES.UnaryExpression &&
      left.operator === 'typeof' &&
      type !== undefined
    ) {
      return { operand: left.argument, type, isEqual: equality === 'equal' };
    }
  }
  return undefined;
}

function nullComparison(
  node: TSESTree.BinaryExpression,
): { operand: TSESTree.Node; isEqual: boolean } | undefined {
  const equality = equalityOf(node);
  if (equality === undefined) {
    return undefined;
  }
  if (isNullish(node.right)) {
    return { operand: node.left, isEqual: equality === 'equal' };
  }
  return isNullish(node.left) ? { operand: node.right, isEqual: equality === 'equal' } : undefined;
}

function implies(
  node: TSESTree.Node,
  name: string,
  isTruthy: boolean,
  context: GuardContext,
): boolean {
  const expression = unwrap(node);
  switch (expression.type) {
    case AST_NODE_TYPES.UnaryExpression:
      return expression.operator === '!' && implies(expression.argument, name, !isTruthy, context);
    case AST_NODE_TYPES.LogicalExpression: {
      const left = implies(expression.left, name, isTruthy, context);
      const right = implies(expression.right, name, isTruthy, context);
      if (expression.operator === '&&') {
        if (isTruthy) {
          return left || right;
        }
        return left && right;
      }
      if (expression.operator === '||') {
        if (isTruthy) {
          return left && right;
        }
        return left || right;
      }
      return false;
    }
    case AST_NODE_TYPES.BinaryExpression: {
      if (expression.operator === 'in') {
        return isTruthy && stringValue(expression.left) === name;
      }
      const typeofTest = typeofComparison(expression);
      if (typeofTest !== undefined) {
        if (!isNamedReference(typeofTest.operand, name, context.services)) {
          return false;
        }
        const isPresenceTypeofTest = typeofTest.isEqual
          ? typeofTest.type !== 'undefined'
          : typeofTest.type === 'undefined';
        return isTruthy ? isPresenceTypeofTest : !isPresenceTypeofTest;
      }
      const nullTest = nullComparison(expression);
      if (
        nullTest === undefined ||
        !isPresenceReference(nullTest.operand, name, context.services)
      ) {
        return false;
      }
      const isPresenceNullTest = !nullTest.isEqual;
      return isTruthy ? isPresenceNullTest : !isPresenceNullTest;
    }
    case AST_NODE_TYPES.Identifier: {
      if (isPresenceReference(expression, name, context.services)) {
        return isTruthy;
      }
      if (context.depth >= MAX_VARIABLE_DEPTH) {
        return false;
      }
      const initializer = constantInitializer(expression, context);
      return (
        initializer !== undefined &&
        implies(initializer, name, isTruthy, { ...context, depth: context.depth + 1 })
      );
    }
    case AST_NODE_TYPES.MemberExpression:
      return isTruthy && isPresenceReference(expression, name, context.services);
    default:
      return false;
  }
}

function exits(statement: TSESTree.Statement): boolean {
  if (statement.type === AST_NODE_TYPES.BlockStatement) {
    const last = statement.body.at(-1);
    return last !== undefined && exits(last);
  }
  return (
    statement.type === AST_NODE_TYPES.ReturnStatement ||
    statement.type === AST_NODE_TYPES.ThrowStatement ||
    statement.type === AST_NODE_TYPES.ContinueStatement ||
    statement.type === AST_NODE_TYPES.BreakStatement
  );
}

function statementsOf(node: TSESTree.Node): readonly TSESTree.Node[] | undefined {
  switch (node.type) {
    case AST_NODE_TYPES.Program:
    case AST_NODE_TYPES.BlockStatement:
    case AST_NODE_TYPES.StaticBlock:
      return node.body;
    case AST_NODE_TYPES.SwitchCase:
      return node.consequent;
    default:
      return undefined;
  }
}

function isTestPosition(node: TSESTree.Node): boolean {
  const parent = node.parent;
  if (parent == null) {
    return false;
  }
  switch (parent.type) {
    case AST_NODE_TYPES.ChainExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
      return isTestPosition(parent);
    case AST_NODE_TYPES.UnaryExpression:
      return parent.operator === '!';
    case AST_NODE_TYPES.IfStatement:
    case AST_NODE_TYPES.WhileStatement:
    case AST_NODE_TYPES.DoWhileStatement:
    case AST_NODE_TYPES.ForStatement:
    case AST_NODE_TYPES.ConditionalExpression:
      return parent.test === node;
    case AST_NODE_TYPES.LogicalExpression:
      return parent.left === node || isTestPosition(parent);
    case AST_NODE_TYPES.BinaryExpression:
      return nullComparison(parent) !== undefined;
    default:
      return false;
  }
}

export function isGuarded(
  node: TSESTree.Node,
  name: string,
  services: ParserServicesWithTypeInformation,
): boolean {
  const parent = node.parent;
  const isTypeofOperand =
    parent?.type === AST_NODE_TYPES.UnaryExpression && parent.operator === 'typeof';
  const isUsedOptionally =
    (parent?.type === AST_NODE_TYPES.MemberExpression &&
      parent.object === node &&
      parent.optional) ||
    (parent?.type === AST_NODE_TYPES.CallExpression && parent.callee === node && parent.optional);
  const isPresenceCheck =
    (isTestPosition(node) || isUsedOptionally) && !hasNullableType(node, services);
  if (isTypeofOperand || isPresenceCheck) {
    return true;
  }
  const context: GuardContext = { services, depth: 0 };
  let child: TSESTree.Node = node;
  let current = parent;
  while (current != null) {
    if (
      current.type === AST_NODE_TYPES.IfStatement ||
      current.type === AST_NODE_TYPES.ConditionalExpression
    ) {
      if (child === current.consequent && implies(current.test, name, true, context)) {
        return true;
      }
      if (child === current.alternate && implies(current.test, name, false, context)) {
        return true;
      }
    }
    if (current.type === AST_NODE_TYPES.LogicalExpression && child === current.right) {
      if (current.operator === '&&' && implies(current.left, name, true, context)) {
        return true;
      }
      if (current.operator === '||' && implies(current.left, name, false, context)) {
        return true;
      }
    }
    const statements = statementsOf(current);
    if (statements !== undefined) {
      const preceding = statements.slice(0, statements.indexOf(child));
      const hasEarlyExit = preceding.some(
        (statement) =>
          statement.type === AST_NODE_TYPES.IfStatement &&
          statement.alternate === null &&
          exits(statement.consequent) &&
          implies(statement.test, name, false, context),
      );
      if (hasEarlyExit) {
        return true;
      }
    }
    child = current;
    current = current.parent;
  }
  return false;
}
