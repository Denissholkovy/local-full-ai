const vscode = require('vscode');
const modelState = require('../modelState');
const { RECOMMENDED_MODELS } = require('../modelPicker');
const { ICONS } = require('../icons');
const ollamaProcess = require('../ollamaProcess');
const skillsLib = require('../skills');
const voice = require('../voice');
const modelTags = require('../modelTags');
const generationLib = require('../generation');
const hardware = require('../hardware');
const cloud = require('../cloudProviders');
const { isVisionModel, cloudCap } = require('../modelCapabilities');
const { CloudClient } = require('../cloudClient');
const cloudLimits = require('../cloudLimits');
const workspaceLib = require('../workspace');
const { resolveWorkspaceRoot } = workspaceLib;


module.exports = { vscode, modelState, RECOMMENDED_MODELS, ICONS, ollamaProcess, skillsLib, voice, modelTags, generationLib, hardware, cloud, isVisionModel, cloudCap, CloudClient, cloudLimits, workspaceLib, resolveWorkspaceRoot };
