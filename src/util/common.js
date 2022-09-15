import { mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import nodePath from 'path';
import { createInterface } from 'readline';
import { URL, fileURLToPath } from 'url';
import notifier from 'node-notifier';
import * as CommentJSON from 'comment-json';
import { CommentLocation, setJSONComment, clearJSONComment } from './comment.js';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

export const projectInfo = JSON.parse(readFileSync(nodePath.resolve(projectRoot, 'package.json')));

export function projectPath(id, suffix) {
    let pathSegments;
    if (Array.isArray(id)) {
        pathSegments = id;
    } else {
        pathSegments = id.split('.');
    }
    pathSegments[pathSegments.length - 1] += `.${suffix || 'json'}`;
    const path = nodePath.resolve(projectRoot, ...pathSegments);
    mkdirSync(nodePath.resolve(path, '..'), { recursive: true });
    return path;
}

export const sleepAsync = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Examples:
 * 1. cachedOutput(id [, nullValue = undefined]) => cache ?? nullValue
 *
 * 2. cachedOutput(id, nonNullValue) => nonNullValue
 *    cache = nonNullValue
 *
 * 3. cachedOutput(id, Promise.resolve(any)) => Promise resolves any
 *    cache = await valueOrProcessor();
 *
 * 4. cachedOutput(id, () => any) => cache ?? any
 *    cache = cache ?? valueOrProcessor()
 *
 * 5. cachedOutput(id, () => Promise.resolve(any)) => cache ?? Promise resolves any
 *    cache = cache ?? await valueOrProcessor()
 */
export function cachedOutput(id, valueOrProcessor) {
    const path = projectPath(id, 'json');
    let useCache = existsSync(path);
    let processor;
    if (valueOrProcessor == null) {
        if (!useCache) return null;
    } else if (valueOrProcessor instanceof Function) {
        processor = valueOrProcessor;
    } else {
        useCache = false;
        processor = () => valueOrProcessor;
    }
    if (useCache) {
        try {
            return CommentJSON.parse(readFileSync(path, 'utf-8'));
        } catch (e) {
            console.error(`Cannot use cache: ${path}`);
        }
        unlinkSync(path);
        return cachedOutput(id, valueOrProcessor);
    }
    const output = processor();
    if (output instanceof Promise) {
        return output.then((outputResolve) => {
            writeFileSync(path, CommentJSON.stringify(outputResolve, null, 4));
            return outputResolve;
        });
    } if (output !== undefined) {
        writeFileSync(path, CommentJSON.stringify(output, null, 4));
    }
    return output;
}

function input(query) {
    return new Promise((resolve) => {
        const rl = createInterface({
            input: process.stdin,
            output: process.stdout
        });
        rl.question(query ?? '', (answer) => {
            resolve(answer);
            rl.close();
        });
    });
}

export function notify(message) {
    notifier.notify({
        title: 'IDList',
        message,
        icon: nodePath.resolve(projectRoot, 'src/assets/icon.png')
    });
}

export function pause(message) {
    notify(message);
    return input(message);
}

export async function runJobsAndReturn(mainJob, ...concurrentJobs) {
    const results = await Promise.all([mainJob, ...concurrentJobs]);
    return results[0];
}

export function uniqueAndSort(array, compareFn) {
    const compare = compareFn ?? ((a, b) => (a < b ? -1 : a === b ? 0 : 1));
    array.sort(compare);
    for (let i = array.length - 2; i >= 0; i--) {
        if (compare(array[i], array[i + 1]) === 0) {
            array.splice(i, 1);
        }
    }
}

/**
 * @template K, V
 * @param {Record<K, V>} object
 * @param {(v: V, k: K, o: Record<K, V>) => void} f
 */
export function forEachObject(object, f, thisArg) {
    Object.keys(object).forEach((key) => f.call(thisArg, object[key], key, object));
}

export function filterObjectMap(map, predicate) {
    const keys = Object.keys(map).filter((key) => predicate(key, map[key], map));
    return CommentJSON.assign({}, map, keys);
}

export function excludeObjectEntry(map, excludeKeys, excludeValues) {
    const excludeKeysOpt = excludeKeys ?? [];
    const excludeValuesOpt = excludeValues ?? [];
    return filterObjectMap(map, (k, v) => !excludeKeysOpt.includes(k) && !excludeValuesOpt.includes(v));
}

export function replaceObjectKey(object, replaceArgsGroups) {
    const newObject = {};
    forEachObject(object, (value, key) => {
        const replacedKey = replaceArgsGroups.reduce((prev, args) => prev.replace(...args), key);
        newObject[replacedKey] = value;
    });
    return newObject;
}

export function keyArrayToObject(arr, f) {
    const obj = {};
    arr.forEach((e, i, a) => (obj[e] = f(e, i, a)));
    return obj;
}

export function kvArrayToObject(kvArray) {
    const obj = {};
    kvArray.forEach(([k, v]) => (obj[k] = v));
    return obj;
}

export function objectToArray(obj, f) {
    return Object.keys(obj).map((k) => f(k, obj[k], obj));
}

export function deepCopy(json) {
    if (Array.isArray(json)) {
        return json.map((e) => deepCopy(e));
    } if (typeof json === 'object') {
        const newObject = {};
        forEachObject(json, (value, key) => {
            newObject[key] = deepCopy(value);
        });
        return newObject;
    }
    return json;
}

export function isExtendFrom(o, parent) {
    return Object.entries(parent).every(([k, v]) => o[k] === v);
}

export function isArraySetEqual(a, b) {
    return a.length === b.length && a.every((e) => b.includes(e));
}

export const stringComparator = (a, b) => (a > b ? 1 : a < b ? -1 : 0);

export function sortObjectKey(o) {
    return kvArrayToObject(Object.entries(o).sort(stringComparator));
}

export function compareMinecraftVersion(a, b) {
    const asVersionArray = (str) => str
        .split('.')
        .map((e) => (e === '*' ? Infinity : parseInt(e, 10)))
        .map((e) => (Number.isNaN(e) ? -1 : e));
    const aver = asVersionArray(a);
    const bver = asVersionArray(b);
    const minLength = Math.min(aver.length, bver.length);
    for (let i = 0; i < minLength; i++) {
        if (aver[i] === bver[i]) continue;
        return aver[i] - bver[i];
    }
    return aver.length - bver.length;
}

export function testMinecraftVersionInRange(version, rangeL, rangeU) {
    return compareMinecraftVersion(version, rangeL) >= 0 && compareMinecraftVersion(version, rangeU) <= 0;
}

export function formatTimeLeft(seconds) {
    const sec = (seconds % 60).toFixed(0);
    const min = (Math.floor(seconds / 60) % 60).toFixed(0);
    const hr = Math.floor(seconds / 3600).toFixed(0);
    if (seconds >= 6000) {
        return `${hr}h${min.padStart(2, '0')}m${sec.padStart(2, '0')}s`;
    } if (seconds >= 60) {
        return `${min}m${sec.padStart(2, '0')}s`;
    }
    return `${seconds.toFixed(1)}s`;
}

export async function retryUntilComplete(maxRetryCount, retryInterval, f) {
    let result;
    let lastError;
    let retryCountLeft = maxRetryCount;
    while (retryCountLeft > 0) {
        try {
            result = await f();
            if (result) return result;
        } catch (err) {
            lastError = err;
        }
        if (retryInterval) await sleepAsync(retryInterval);
        retryCountLeft--;
    }
    throw lastError || new Error('Retry count limit exceeded');
}

export function cascadeMap(mapOfMap, priority, includeAll) {
    const result = {};
    let i;
    if (includeAll) {
        for (const value of Object.values(mapOfMap)) {
            CommentJSON.assign(result, value);
        }
    }
    for (i = priority.length - 1; i >= 0; i--) {
        CommentJSON.assign(result, mapOfMap[priority[i]]);
    }
    return result;
}

export function removeMinecraftNamespace(array) {
    return array
        .map((item) => {
            if (!item.includes(':')) {
                const nameWithNamespace = `minecraft:${item}`;
                if (array.includes(nameWithNamespace)) {
                    return null;
                }
            }
            return item;
        })
        .filter((item) => item != null);
}

export function setInlineCommentAfterField(obj, fieldName, comment) {
    const symbol = CommentLocation.after(fieldName);
    if (comment) {
        setJSONComment(obj, symbol, 'inlineLine', ` ${comment}`);
    } else {
        clearJSONComment(obj, symbol);
    }
}

export async function forEachArray(arr, f, thisArg) {
    const len = arr.length;
    for (let i = 0; i < len; i++) {
        await f.call(thisArg, arr[i], i, arr);
    }
}

export function readStreamOnce(stream, timeout) {
    const data = stream.read();
    if (data === null) {
        return new Promise((resolve, reject) => {
            let readableCallback;
            let errorCallback;
            let timeoutId;
            const callback = (error, result) => {
                stream.off('readable', readableCallback);
                stream.off('error', errorCallback);
                clearTimeout(timeoutId);
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            };
            readableCallback = () => {
                callback(null, stream.read());
            };
            errorCallback = (err) => {
                callback(err);
            };
            stream.on('readable', readableCallback);
            stream.on('error', errorCallback);
            if (timeout > 0) {
                const timeoutError = new Error(`Timeout ${timeout} exceed.`);
                timeoutId = setTimeout(() => {
                    callback(timeoutError);
                }, timeout);
            }
        });
    }
    return data;
}
