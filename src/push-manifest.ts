/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as path from 'path';
import {Analyzer, Document, Import} from 'polymer-analyzer';
import {ProjectConfig} from 'polymer-project-config';
import File = require('vinyl');

import {urlFromPath} from './path-transformers';
import {FileMapUrlLoader} from './file-map-url-loader';
import {AsyncTransformStream} from './streams';

/**
 * Push Manifest Types Definitions
 * A push manifest is a JSON object representing relative application URL and
 * the resources that should be pushed when those URLs are requested by the
 * server. Below is a example of this data format:
 *
 *       {
 *         "index.html": {       // PushManifestEntryCollection
 *           "/css/app.css": {   // PushManifestEntry
 *             "type": "style",  // ResourceType
 *             "weight": 1
 *           },
 *           ...
 *         },
 *         "page.html": {
 *           "/css/page.css": {
 *             "type": "style",
 *             "weight": 1
 *           },
 *           ...
 *         }
 *       }
 *
 * NOTE(fks) 04-05-2017: Only weight=1 is supported by browsers at the moment.
 * When support is added, we can add automatic weighting and support multiple
 * numbers.
 */
export type ResourceType = 'document' | 'script' | 'style' | 'image' | 'font';
export interface PushManifestEntry {
  type?: ResourceType;
  weight?: 1;
}
export interface PushManifestEntryCollection {
  [dependencyAbsoluteUrl: string]: PushManifestEntry;
}
export interface PushManifest {
  [requestAbsoluteUrl: string]: PushManifestEntryCollection;
}

/**
 * A mapping of file extensions and their default resource type.
 */
const extensionToTypeMapping = new Map<string, ResourceType>([
  ['.css', 'style'],
  ['.gif', 'image'],
  ['.html', 'document'],
  ['.png', 'image'],
  ['.jpg', 'image'],
  ['.js', 'script'],
  ['.json', 'script'],
  ['.svg', 'image'],
  ['.webp', 'image'],
  ['.woff', 'font'],
  ['.woff2', 'font'],
]);

/**
 * Get the default resource type for a file based on its extension.
 */
function getResourceTypeFromUrl(url: string): ResourceType|undefined {
  return extensionToTypeMapping.get(path.extname(url));
}

/**
 * Get the resource type for an import, handling special import types and
 * falling back to getResourceTypeFromUrl() if the resource type can't be
 * detected directly from importFeature.
 */
function getResourceTypeFromImport(importFeature: Import): ResourceType|
    undefined {
  const importKinds = importFeature.kinds;
  if (importKinds.has('css-import') || importKinds.has('html-style')) {
    return 'style';
  }
  if (importKinds.has('html-import')) {
    return 'document';
  }
  if (importKinds.has('html-script')) {
    return 'script';
  }
  // @NOTE(fks) 04-07-2017: A js-import can actually import multiple types of
  // resources, so we can't guarentee that it's a script and should instead rely
  // on the default file-extension mapping.
  return getResourceTypeFromUrl(importFeature.url);
}

/**
 * Create a PushManifestEntry from an analyzer Import.
 */
function createPushEntryFromImport(importFeature: Import): PushManifestEntry {
  return {
    type: getResourceTypeFromImport(importFeature),
    weight: 1,
  };
}

/**
 * Analyze the given URL and resolve with a collection of push manifest entries
 * to be added to the overall push manifest.
 */
async function generatePushManifestEntryForUrl(
    analyzer: Analyzer, url: string, ignoreUrls?: string[]):
    Promise<PushManifestEntryCollection> {
  const analysis = await analyzer.analyze([url]);
  const analyzedDocument = analysis.getDocument(url);

  if (!(analyzedDocument instanceof Document)) {
    const message = analyzedDocument && analyzedDocument.message || 'unknown';
    throw new Error(`Unable to get document ${url}: ${message}`);
  }

  const analyzedImports = analyzedDocument.getFeatures(
      {kind: 'import', externalPackages: true, imported: true});
  const pushManifestEntries: PushManifestEntryCollection = {};
  function shouldIgnoreFile(url: string) {
    return ignoreUrls && ignoreUrls.indexOf(url) > -1;
  }

  for (const analyzedImport of analyzedImports) {
    // TODO This import URL does not respect the document's base tag.
    // Probably an issue more generally with all URLs analyzed out of
    // documents, but base tags are somewhat rare.
    const analyzedImportUrl = analyzedImport.url;
    const analyzedImportEntry = pushManifestEntries[analyzedImportUrl];
    if (!shouldIgnoreFile(analyzedImportUrl) && !analyzedImportEntry) {
      pushManifestEntries[analyzedImportUrl] =
          createPushEntryFromImport(analyzedImport);
    }
  }

  return pushManifestEntries;
}


/**
 * A stream that reads in files from an application to generate an HTTP2/Push
 * manifest that gets injected into the stream.
 */
export class AddPushManifest extends AsyncTransformStream<File, File> {
  files: Map<string, File>;
  outPath: string;
  private config: ProjectConfig;
  private analyzer: Analyzer;
  private basePath: string;

  constructor(config: ProjectConfig, outPath?: string, basePath?: string) {
    super({objectMode: true});
    this.files = new Map();
    this.config = config;
    this.analyzer = new Analyzer({urlLoader: new FileMapUrlLoader(this.files)});
    this.outPath = path.join(this.config.root, outPath || 'push-manifest.json');
    this.basePath = (basePath || '');
  }

  protected async *
      _transformIter(files: AsyncIterable<File>): AsyncIterable<File> {
    for await (const file of files) {
      this.files.set(urlFromPath(this.config.root, file.path), file);
      yield file;
    }

    // Generate a push manifest, and propagate any errors up.
    const pushManifest = await this.generatePushManifest();
    const pushManifestContents = JSON.stringify(pushManifest, undefined, '  ');
    // Push the new push manifest into the stream.
    yield new File({
      path: this.outPath,
      contents: new Buffer(pushManifestContents),
    });
  }

  async generatePushManifest(): Promise<PushManifest> {
    const pushManifest: PushManifest = {};
    // If an app-shell exists, use that as our main push URL because it has a
    // reliable URL. Otherwise, support the single entrypoint URL.
    const mainPushEntrypoint = this.config.shell || this.config.entrypoint;
    // Generate the dependencies to push for the shell
    const absoluteShellUrl = urlFromPath(this.config.root, mainPushEntrypoint);
    pushManifest[absoluteShellUrl] =
        await generatePushManifestEntryForUrl(this.analyzer, absoluteShellUrl);
    const shellImportUrls = Object.keys(pushManifest[absoluteShellUrl]);
    const fragmentIgnoreUrls = [absoluteShellUrl].concat(shellImportUrls);
    // Generate the dependencies to push for each fragment.
    for (const fragment of this.config.fragments) {
      const absoluteFragmentUrl = urlFromPath(this.config.root, fragment);
      pushManifest[absoluteFragmentUrl] = await generatePushManifestEntryForUrl(
          this.analyzer, absoluteFragmentUrl, fragmentIgnoreUrls);
    }

    // The URLs we got may be absolute or relative depending on how they were
    // declared in the source. This will normalize them to relative by stripping
    // any leading slash.
    //
    // TODO Decide whether they should really be relative or absolute. Relative
    // was chosen here only because most links were already relative so it was
    // a smaller change, but
    // https://github.com/GoogleChrome/http2-push-manifest actually shows
    // relative for the keys and absolute for the values.
    const normalize = (p: string) =>
        path.posix.join(this.basePath, p).replace(/^\/+/, '');

    const normalized: PushManifest = {};
    for (const source of Object.keys(pushManifest)) {
      const targets: PushManifestEntryCollection = {};
      for (const target of Object.keys(pushManifest[source])) {
        targets[normalize(target)] = pushManifest[source][target];
      }
      normalized[normalize(source)] = targets;
    }
    return normalized;
  }
}
