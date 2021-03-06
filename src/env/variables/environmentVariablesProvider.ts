// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { ConfigurationChangeEvent, Disposable, Event, EventEmitter, FileSystemWatcher, Uri } from 'vscode';
import { IWorkspaceService } from '../application/types';
import { IPlatformService } from '../platform/types';
import { IConfigurationService, ICurrentProcess, IDisposableRegistry } from '../types';
import { cacheResourceSpecificInterpreterData, clearCachedResourceSpecificIngterpreterData } from '../utils/decorators';
import { EnvironmentVariables, IEnvironmentVariablesProvider, IEnvironmentVariablesService } from './types';

const cacheDuration = 60 * 60 * 1000;
export class EnvironmentVariablesProvider implements IEnvironmentVariablesProvider, Disposable {
    public trackedWorkspaceFolders = new Set<string>();
    private fileWatchers = new Map<string, FileSystemWatcher>();
    private disposables: Disposable[] = [];
    private changeEventEmitter: EventEmitter<Uri | undefined>;
    constructor(private envVarsService: IEnvironmentVariablesService,
        disposableRegistry: Disposable[],
        private platformService: IPlatformService,
        private workspaceService: IWorkspaceService,
        private readonly configurationService: IConfigurationService,
        private process: ICurrentProcess) {
        disposableRegistry.push(this);
        this.changeEventEmitter = new EventEmitter();
        const disposable = this.workspaceService.onDidChangeConfiguration(this.configurationChanged, this);
        this.disposables.push(disposable);
    }

    public get onDidEnvironmentVariablesChange(): Event<Uri | undefined> {
        return this.changeEventEmitter.event;
    }

    public dispose() {
        this.changeEventEmitter.dispose();
        this.fileWatchers.forEach(watcher => {
            if (watcher) {
                watcher.dispose();
            }
        });
    }
    @cacheResourceSpecificInterpreterData('getEnvironmentVariables', cacheDuration)
    public async getEnvironmentVariables(resource?: Uri): Promise<EnvironmentVariables> {
        const settings = this.configurationService.getSettings(resource);
        const workspaceFolderUri = this.getWorkspaceFolderUri(resource);
        this.trackedWorkspaceFolders.add(workspaceFolderUri ? workspaceFolderUri.fsPath : '');
        this.createFileWatcher(settings.envFile, workspaceFolderUri);
        let mergedVars = await this.envVarsService.parseFile(settings.envFile, this.process.env);
        if (!mergedVars) {
            mergedVars = {};
        }
        this.envVarsService.mergeVariables(this.process.env, mergedVars!);
        const pathVariable = this.platformService.pathVariableName;
        const pathValue = this.process.env[pathVariable];
        if (pathValue) {
            this.envVarsService.appendPath(mergedVars!, pathValue);
        }
        if (this.process.env.PYTHONPATH) {
            this.envVarsService.appendPythonPath(mergedVars!, this.process.env.PYTHONPATH);
        }
        return mergedVars;
    }
    public configurationChanged(e: ConfigurationChangeEvent) {
        this.trackedWorkspaceFolders.forEach(item => {
            const uri = item && item.length > 0 ? Uri.file(item) : undefined;
            if (e.affectsConfiguration('python.envFile', uri)) {
                this.onEnvironmentFileChanged(uri);
            }
        });
    }
    public createFileWatcher(envFile: string, workspaceFolderUri?: Uri) {
        if (this.fileWatchers.has(envFile)) {
            return;
        }
        const envFileWatcher = this.workspaceService.createFileSystemWatcher(envFile);
        this.fileWatchers.set(envFile, envFileWatcher);
        if (envFileWatcher) {
            this.disposables.push(envFileWatcher.onDidChange(() => this.onEnvironmentFileChanged(workspaceFolderUri)));
            this.disposables.push(envFileWatcher.onDidCreate(() => this.onEnvironmentFileChanged(workspaceFolderUri)));
            this.disposables.push(envFileWatcher.onDidDelete(() => this.onEnvironmentFileChanged(workspaceFolderUri)));
        }
    }
    private getWorkspaceFolderUri(resource?: Uri): Uri | undefined {
        if (!resource) {
            return;
        }
        const workspaceFolder = this.workspaceService.getWorkspaceFolder(resource!);
        return workspaceFolder ? workspaceFolder.uri : undefined;
    }
    private onEnvironmentFileChanged(workspaceFolderUri?: Uri) {
        clearCachedResourceSpecificIngterpreterData('getEnvironmentVariables', workspaceFolderUri);
        clearCachedResourceSpecificIngterpreterData('CustomEnvironmentVariables', workspaceFolderUri);
        this.changeEventEmitter.fire(workspaceFolderUri);
    }
}