const sharp = require("sharp");
const assert = require("assert").strict;
const tesseract = require("node-tesseract-ocr");
const {
    newAdbClient,
    getAnyOnlineDevice,
    waitForAnyDevice,
    adbShell,
    getDeviceSurfaceOrientation,
    openMonkey,
    sendMonkeyCommand,
} = require("../util/adb");
const {
    openMinicap,
    stopMinicap,
    captureScreen,
    peekImageFromMinicap
} = require("../util/captureScreen");
const { 
    sleepAsync,
    cachedOutput,
    pause,
    runJobsAndReturn,
    testMinecraftVersionInRange,
    retryUntilComplete,
    formatTimeLeft
} = require("../util/common");

async function captureScreenCompat(device, minicapHandler) {
    if (minicapHandler) {
        return await peekImageFromMinicap(minicapHandler);
    } else {
        return await captureScreen(device);
    }
}

async function recogizeCommand(cx, screenshotImage, surfaceOrientation) {
    let commandAreaRect = cx.commandAreaRect[surfaceOrientation];
    let img = sharp(screenshotImage);
    img.removeAlpha()
        .extract({
            left: commandAreaRect[0],
            top: commandAreaRect[1],
            width: commandAreaRect[2],
            height: commandAreaRect[3]
        })
        .negate()
        .threshold(60);
    let commandTextImage = await img.png().toBuffer();
    // await img.png().toFile("test.png");
    let commandText = await tesseract.recognize(commandTextImage, {
        ...cx.tesseractOptions,
        lang: "eng",
        psm: 7,
        oem: 3
    });
    commandText = commandText.trim();
    if (commandText in cx.tesseractMistakes) {
        return cx.tesseractMistakes[commandText];
    }
    return commandText;
}

async function recogizeCommandRemoteSync(cx, device, surfaceOrientation) {
    return await recogizeCommand(cx, await captureScreen(device), surfaceOrientation);
}

function guessTruncatedString(truncatedStr, startsWith) {
    let spos, tpos;
    for (spos = 0; spos < startsWith.length; spos++) {
        tpos = truncatedStr.indexOf(startsWith.slice(spos));
        if (tpos >= 0 && tpos <= 3) {
            return startsWith + truncatedStr.slice(tpos - spos + startsWith.length);
        }
    }
    return null;
}

/** @deprecated */
async function analyzeCommandAutocompletion(device, command, progressName, approxLength) {
    // 初始状态：游戏HUD
    let autocompletions = [];
    let surfaceOrientation = await getDeviceSurfaceOrientation(device);
    let monkey = await openMonkey(device);
    let minicap;
    try {
        minicap = await openMinicap(device);
    } catch(err) {
        console.error("Open minicap failed, fallback to screencap", err);
    }
    
    // 打开聊天栏
    await sendMonkeyCommand(monkey, "press KEYCODE_T");

    console.log(`Starting ${progressName}: ${command}`);
    await adbShell(device, "input text " + JSON.stringify(command));

    let screenshotImage = await captureScreenCompat(device, minicap);
    const pressTabThenCapture = async () => {
        await sendMonkeyCommand(monkey, "press KEYCODE_TAB");
        await sleepAsync(300); // wait for responding to key events
        screenshotImage = await captureScreenCompat(device, minicap);
    };
    let autocompletedCommand = command.trim();
    let recogizedCommand = await runJobsAndReturn(
        recogizeCommand(cx, screenshotImage, surfaceOrientation),
        pressTabThenCapture()
    );
    assert.equal(recogizedCommand, autocompletedCommand);
    let timeStart = Date.now(), stepCount = 0;
    while(true) {
        let newRecognizedCommand = await runJobsAndReturn(
            recogizeCommand(cx, screenshotImage, surfaceOrientation),
            pressTabThenCapture()
        );
        assert.notEqual(newRecognizedCommand, recogizedCommand);
        recogizedCommand = newRecognizedCommand;

        autocompletedCommand = guessTruncatedString(recogizedCommand, command);
        if (!autocompletedCommand) {
            throw new Error("Auto-completed command test failed: " + recogizedCommand);
        }

        let autocompletion = autocompletedCommand.slice(command.length);
        if (autocompletions.includes(autocompletion)) {
            console.log("Exit condition: " + autocompletion);
            break;
        } else {
            autocompletions.push(autocompletion);
            if (approxLength) {
                let stepSpentAvg = (Date.now() - timeStart) / ++stepCount;
                let percentage = (autocompletions.length / approxLength * 100).toFixed(1);
                let timeLeft = (approxLength - autocompletions.length) * stepSpentAvg;
                let timeLeftStr = formatTimeLeft(timeLeft / 1000);
                let estTimeStr = new Date(Date.now() + timeLeft).toLocaleTimeString();
                console.log(`[${autocompletions.length}/${approxLength} ${percentage}% ${estTimeStr} ~${timeLeftStr}]${progressName} ${recogizedCommand}`);
            } else {
                console.log(`[${autocompletions.length}/?]${progressName} ${recogizedCommand}`);
            }
        }
    }

    // 退出聊天栏
    await sendMonkeyCommand(monkey, "press KEYCODE_ESCAPE");
    await sendMonkeyCommand(monkey, "press KEYCODE_ESCAPE");
    await sendMonkeyCommand(monkey, "quit");
    monkey.end();

    if (minicap) {
        await stopMinicap(device, minicap);
    }

    return autocompletions;
}

async function analyzeCommandAutocompletionSync(cx, device, command, progressName, approxLength) {
    // 初始状态：游戏HUD
    let autocompletions = [];
    let surfaceOrientation = await getDeviceSurfaceOrientation(device);
    let monkey = await openMonkey(device);
    let minicap;
    try {
        minicap = await openMinicap(device);
    } catch(err) {
        console.error("Open minicap failed, fallback to screencap", err);
    }
    
    // 打开聊天栏
    await sendMonkeyCommand(monkey, "press KEYCODE_T");

    console.log(`Starting ${progressName}: ${command}`);
    await adbShell(device, "input text " + JSON.stringify(command));

    let autocompletedCommand = command.trim();
    let recogizedCommand = await retryUntilComplete(10, 0, async () => {
        let screenshotImage = await captureScreenCompat(device, minicap);
        let command = await recogizeCommand(cx, screenshotImage, surfaceOrientation);
        assert.equal(command, autocompletedCommand);
        return command;
    });
    let timeStart = Date.now(), stepCount = 0;
    while(true) {
        await sendMonkeyCommand(monkey, "press KEYCODE_TAB");
        recogizedCommand = await retryUntilComplete(10, 0, async () => {
            let screenshotImage = await captureScreenCompat(device, minicap);
            let command = await recogizeCommand(cx, screenshotImage, surfaceOrientation);
            assert.notEqual(recogizedCommand, command);
            return command;
        });

        autocompletedCommand = guessTruncatedString(recogizedCommand, command);
        if (!autocompletedCommand) {
            throw new Error("Auto-completed command test failed: " + recogizedCommand);
        }

        let autocompletion = autocompletedCommand.slice(command.length);
        if (autocompletions.includes(autocompletion)) {
            console.log("Exit condition: " + autocompletion);
            break;
        } else {
            autocompletions.push(autocompletion);
            if (approxLength) {
                let stepSpentAvg = (Date.now() - timeStart) / ++stepCount;
                let percentage = (autocompletions.length / approxLength * 100).toFixed(1);
                let timeLeft = (approxLength - autocompletions.length) * stepSpentAvg;
                let timeLeftStr = formatTimeLeft(timeLeft / 1000);
                let estTimeStr = new Date(Date.now() + timeLeft).toLocaleTimeString();
                console.log(`[${autocompletions.length}/${approxLength} ${percentage}% ${estTimeStr} ~${timeLeftStr}]${progressName} ${recogizedCommand}`);
            } else {
                console.log(`[${autocompletions.length}/?]${progressName} ${recogizedCommand}`);
            }
        }
    }

    // 退出聊天栏
    await sendMonkeyCommand(monkey, "press KEYCODE_ESCAPE");
    await sendMonkeyCommand(monkey, "press KEYCODE_ESCAPE");
    await sendMonkeyCommand(monkey, "quit");
    monkey.end();

    if (minicap) {
        await stopMinicap(device, minicap);
    }

    return autocompletions;
}

async function analyzeAutocompletionEnumCached(cx, options, name, commandPrefix, exclusion) {
    const { version, branch, packageVersion } = cx;
    const { device, target } = options;
    const id = name.replace(/\s+(\S)/g, (_, ch) => ch.toUpperCase());
    const cacheId = `version.${version}.autocompletion.${branch.id}.${name.replace(/\s+/g, "_")}`;
    let cache = cachedOutput(cacheId), result;

    if (Array.isArray(cache)) cache = { result: cache, length: cache.length };
    if (cache && packageVersion == cache.packageVersion) result = cache.result;
    if (!result) {
        const progressName = `${version}.${branch.id}.${name.replace(/\s+/g, "_")}`;
        result = await analyzeCommandAutocompletionSync(cx, device, commandPrefix, progressName, cache && cache.length);
        if (exclusion) result = result.filter(e => !exclusion.includes(e));
        cachedOutput(cacheId, { packageVersion, result, length: result.length });
    }
    return target[id] = result;
}

async function analyzeAutocompletionEnumsCached(cx) {
    const { version, branch, packageVersion } = cx;
    const cacheId = `version.${version}.autocompletion.${branch.id}`;
    const cache = cachedOutput(cacheId);
    if (cache && packageVersion == cache.packageVersion) return cache;

	console.log("Connecting ADB host...");
	let adbClient = newAdbClient();
    console.log("Connecting to device...");
    let device = await getAnyOnlineDevice(adbClient);
    if (!device) {
        console.log("Please plug in the device...");
        device = await waitForAnyDevice(adbClient);
    }

    console.log("Please switch to branch: " + branch.id);
    await pause("Press <Enter> if the device is ready");
    const target = { packageVersion };
    const options = {
        device, target
    };

    await analyzeAutocompletionEnumCached(cx, options, "blocks", "/testforblock ~ ~ ~ ");
    await analyzeAutocompletionEnumCached(cx, options, "items", "/clear @s ", [ "[" ]);
    await analyzeAutocompletionEnumCached(cx, options, "entities", "/testfor @e[type=", [ "!" ]);
    await analyzeAutocompletionEnumCached(cx, options, "summonable entities", "/summon ");
    await analyzeAutocompletionEnumCached(cx, options, "effects", "/effect @s ", [ "[", "clear" ]);
    await analyzeAutocompletionEnumCached(cx, options, "enchantments", "/enchant @s ", [ "[" ]);
    await analyzeAutocompletionEnumCached(cx, options, "gamerules", "/gamerule ");
    await analyzeAutocompletionEnumCached(cx, options, "locations", "/locate ");
    await analyzeAutocompletionEnumCached(cx, options, "mobevents", "/mobevent ");
    await analyzeAutocompletionEnumCached(cx, options, "selectors", "/testfor @e[");

    if (
        testMinecraftVersionInRange(packageVersion, "1.18.0.21", "1.18.0.21") ||
        testMinecraftVersionInRange(packageVersion, "1.18.10.21", "*")
    ) {
        await analyzeAutocompletionEnumCached(cx, options, "loot tools", "/loot spawn ~ ~ ~ loot empty ", [ "mainhand", "offhand" ]);
    }

    return cachedOutput(cacheId, target);
}

module.exports = {
    analyzeAutocompletionEnumsCached
};