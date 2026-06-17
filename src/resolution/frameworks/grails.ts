/**
 * Grails Framework Resolver
 *
 * Handles Groovy on Grails patterns (2.x through 7.x): URL mappings, controllers,
 * services, and domain classes.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const grailsResolver: FrameworkResolver = {
  name: 'grails',
  languages: ['groovy'],

  claimsReference(name: string): boolean {
    return /^[\w.]+\.[\w]+#\w+$/.test(name) || /^[\w/]+#\w+$/.test(name);
  },

  detect(context: ResolutionContext): boolean {
    const buildGradle = context.readFile('build.gradle');
    if (buildGradle && (
      buildGradle.includes('org.grails') ||
      buildGradle.includes('grails-gradle-plugin') ||
      buildGradle.includes('grails-core')
    )) {
      return true;
    }

    const buildGradleKts = context.readFile('build.gradle.kts');
    if (buildGradleKts && (
      buildGradleKts.includes('org.grails') ||
      buildGradleKts.includes('grails-gradle-plugin')
    )) {
      return true;
    }

    if (context.fileExists('grails-app/conf/UrlMappings.groovy')) return true;
    if (context.fileExists('grails-app/controllers')) return true;

    const buildConfig = context.readFile('grails-app/conf/BuildConfig.groovy');
    if (buildConfig && buildConfig.includes('grails.project')) return true;

    const appYml = context.readFile('grails-app/conf/application.yml');
    if (appYml && appYml.includes('grails:')) return true;

    const appGroovy = context.readFile('grails-app/conf/application.groovy');
    if (appGroovy && appGroovy.includes('grails')) return true;

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const ca = ref.referenceName.match(/^([\w./]+)#(\w+)$/);
    if (ca) {
      const result = resolveControllerAction(ca[1]!, ca[2]!, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' };
      }
      return null;
    }

    if (ref.referenceName.endsWith('Controller')) {
      const result = resolveController(ref.referenceName, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.85, resolvedBy: 'framework' };
      }
    }

    if (ref.referenceName.endsWith('Service')) {
      const result = resolveService(ref.referenceName, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
      }
    }

    if (/^[A-Z][a-zA-Z0-9]*$/.test(ref.referenceName)) {
      const result = resolveDomain(ref.referenceName, context);
      if (result) {
        return { original: ref, targetNodeId: result, confidence: 0.8, resolvedBy: 'framework' };
      }
    }

    return null;
  },

  extract(filePath, content) {
    if (!filePath.endsWith('.groovy')) return { nodes: [], references: [] };
    if (!filePath.includes('UrlMappings')) return { nodes: [], references: [] };

    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();
    const safe = stripCommentsForRegex(content, 'groovy');

    // "/path"(controller: "book", action: "index")
    const inlineRoute =
      /"([^"]+)"\s*\(\s*controller\s*:\s*["'](\w+)["']\s*,\s*action\s*:\s*["'](\w+)["']\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = inlineRoute.exec(safe)) !== null) {
      const [, routePath, ctrl, action] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:GET:${routePath}`,
        kind: 'route',
        name: `GET ${routePath}`,
        qualifiedName: `${filePath}::route:${ctrl}#${action}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'groovy',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: `${ctrl}#${action}`,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'groovy',
      });
    }

    // "/path" { controller = "book"; action = "list" }
    const blockRoute =
      /"([^"]+)"\s*\{[^}]*?controller\s*=\s*["'](\w+)["'][^}]*?action\s*=\s*["'](\w+)["'][^}]*\}/gs;
    while ((match = blockRoute.exec(safe)) !== null) {
      const [, routePath, ctrl, action] = match;
      const line = safe.slice(0, match.index).split('\n').length;
      const routeNode: Node = {
        id: `route:${filePath}:${line}:GET:${routePath}:block`,
        kind: 'route',
        name: `GET ${routePath}`,
        qualifiedName: `${filePath}::route:${ctrl}#${action}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: 'groovy',
        updatedAt: now,
      };
      nodes.push(routeNode);
      references.push({
        fromNodeId: routeNode.id,
        referenceName: `${ctrl}#${action}`,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'groovy',
      });
    }

    return { nodes, references };
  },
};

function camelizeController(ctrl: string): string {
  const base = ctrl.includes('.') ? ctrl.split('.').pop()! : ctrl;
  return base.charAt(0).toUpperCase() + base.slice(1) + 'Controller';
}

function resolveControllerAction(ctrlPath: string, action: string, context: ResolutionContext): string | null {
  const ctrlName = camelizeController(ctrlPath);
  const candidates = context.getNodesByName(ctrlName).filter((n) => n.kind === 'class');
  for (const ctrl of candidates) {
    if (!ctrl.filePath.includes('grails-app/controllers') && !ctrl.filePath.endsWith('Controller.groovy')) {
      continue;
    }
    const method = context.getNodesInFile(ctrl.filePath).find(
      (n) => (n.kind === 'method' || n.kind === 'function') && n.name === action,
    );
    if (method) return method.id;
  }

  const snake = ctrlPath.replace(/\./g, '/');
  const direct = `grails-app/controllers/${snake}Controller.groovy`;
  if (context.fileExists(direct)) {
    const method = context.getNodesInFile(direct).find(
      (n) => (n.kind === 'method' || n.kind === 'function') && n.name === action,
    );
    if (method) return method.id;
  }

  return null;
}

function resolveController(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name).filter((n) => n.kind === 'class');
  const ctrl = candidates.find((n) =>
    n.filePath.includes('grails-app/controllers') || n.filePath.endsWith('Controller.groovy'),
  );
  return ctrl?.id ?? null;
}

function resolveService(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name).filter((n) => n.kind === 'class');
  const svc = candidates.find((n) =>
    n.filePath.includes('grails-app/services') || n.filePath.endsWith('Service.groovy'),
  );
  return svc?.id ?? null;
}

function resolveDomain(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name).filter((n) => n.kind === 'class');
  const domain = candidates.find((n) =>
    n.filePath.includes('grails-app/domain') || n.filePath.includes('grails-app/domains'),
  );
  return domain?.id ?? null;
}
