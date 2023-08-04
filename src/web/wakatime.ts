import * as vscode from 'vscode';

import { COMMAND_DASHBOARD, LogLevel } from '../constants';
import { Logger } from './logger';
import { Utils } from '../utils';
import { Memento } from 'vscode';

interface FileSelection {
  selection: vscode.Position;
  lastHeartbeatAt: number;
}

interface FileSelectionMap {
  [key: string]: FileSelection;
}

export class WakaTime {
  private agentName: string;
  private extension: any;
  private statusBar?: vscode.StatusBarItem = undefined;
  private statusBarTeamYou?: vscode.StatusBarItem = undefined;
  private statusBarTeamOther?: vscode.StatusBarItem = undefined;
  private disposable: vscode.Disposable;
  private lastFile: string;
  private lastHeartbeat: number = 0;
  private lastDebug: boolean = false;
  private lastCompile: boolean = false;
  private dedupe: FileSelectionMap = {};
  private debounceTimeoutId: any = null;
  private debounceMs = 50;
  private logger: Logger;
  private config: Memento;
  private fetchTodayInterval: number = 60000;
  private lastFetchToday: number = 0;
  private showStatusBar: boolean;
  private showStatusBarTeam: boolean;
  private hasTeamFeatures: boolean;
  private showCodingActivity: boolean;
  private disabled: boolean = true;
  private isCompiling: boolean = false;
  private isDebugging: boolean = false;
  private currentlyFocusedFile: string;
  private teamDevsForFileCache = {};

  constructor(logger: Logger, config: Memento) {
    this.logger = logger;
    this.config = config;
  }

  public initialize(): void {
    if (this.config.get('wakatime.debug') == 'true') {
      this.logger.setLevel(LogLevel.DEBUG);
    }

    let extension = vscode.extensions.getExtension('ZeedasBeta.vscode-zeedas');
    this.extension = (extension != undefined && extension.packageJSON) || { version: '0.0.0' };
    this.agentName = 'vscode';

    this.disabled = this.config.get('wakatime.disabled') === 'true';
    if (this.disabled) {
      this.dispose();
      return;
    }

    this.initializeDependencies();
  }

  public dispose() {
    this.statusBar?.dispose();
    this.statusBarTeamYou?.dispose();
    this.statusBarTeamOther?.dispose();
    this.disposable?.dispose();
  }

  public initializeDependencies(): void {
    this.logger.debug(`Initializing Zeedas Beta v${this.extension.version}`);

    this.statusBar = vscode.window.createStatusBarItem("com.wakatime.statusbar", vscode.StatusBarAlignment.Left, 3);
    this.statusBar.command = COMMAND_DASHBOARD;

    this.statusBarTeamYou = vscode.window.createStatusBarItem("com.wakatime.teamyou", vscode.StatusBarAlignment.Left, 2);
    this.statusBarTeamOther = vscode.window.createStatusBarItem("com.wakatime.teamother", vscode.StatusBarAlignment.Left, 1);

    const showStatusBar = this.config.get('wakatime.status_bar_enabled');
    this.showStatusBar = showStatusBar !== 'false';

    const showStatusBarTeam = this.config.get('wakatime.status_bar_team');
    this.showStatusBarTeam = showStatusBarTeam !== 'false';

    this.setStatusBarVisibility(this.showStatusBar);
    this.updateStatusBarText('ZeedasBeta Initializing...');

    this.checkApiKey();

    this.setupEventListeners();

    this.logger.debug('ZeedasBeta initialized.');

    const showCodingActivity = this.config.get('wakatime.status_bar_coding_activity');
    this.showCodingActivity = showCodingActivity !== 'false';

    this.updateStatusBarText();
    this.updateStatusBarTooltip('ZeedasBeta: Initialized');
    this.getCodingActivity();
  }

  private updateStatusBarText(text?: string): void {
    if (!this.statusBar) return;
    if (!text) {
      this.statusBar.text = '$(clock)';
    } else {
      this.statusBar.text = '$(clock) ' + text;
    }
  }

  private updateStatusBarTooltip(tooltipText: string): void {
    if (!this.statusBar) return;
    this.statusBar.tooltip = tooltipText;
  }

  private updateTeamStatusBarTextForCurrentUser(text?: string): void {
    if (!this.statusBarTeamYou) return;
    if (!text) {
      this.statusBarTeamYou.text = '';
    } else {
      this.statusBarTeamYou.text = text;
    }
  }

  private updateStatusBarTooltipForCurrentUser(tooltipText: string): void {
    if (!this.statusBarTeamYou) return;
    this.statusBarTeamYou.tooltip = tooltipText;
  }

  private updateTeamStatusBarTextForOther(text?: string): void {
    if (!this.statusBarTeamOther) return;
    if (!text) {
      this.statusBarTeamOther.text = '';
    } else {
      this.statusBarTeamOther.text = text;
    }
  }

  private updateStatusBarTooltipForOther(tooltipText: string): void {
    if (!this.statusBarTeamOther) return;
    this.statusBarTeamOther.tooltip = tooltipText;
  }

  private statusBarShowingError(): boolean {
    if (!this.statusBar) return false;
    return this.statusBar.text.indexOf('Error') != -1;
  }

  public promptForApiKey(): void {
    let defaultVal: string = this.config.get('wakatime.apiKey') || '';
    if (Utils.apiKeyInvalid(defaultVal)) defaultVal = '';
    let promptOptions = {
      prompt: 'ZeedasBeta Api Key',
      placeHolder: 'Enter your api key',
      value: defaultVal,
      ignoreFocusOut: true,
      validateInput: Utils.apiKeyInvalid.bind(this),
    };
    vscode.window.showInputBox(promptOptions).then((val) => {
      if (val != undefined) {
        let invalid = Utils.apiKeyInvalid(val);
        if (!invalid) this.config.update('wakatime.apiKey', val);
        else vscode.window.setStatusBarMessage(invalid);
      } else vscode.window.setStatusBarMessage('ZeedasBeta api key not provided');
    });
  }

  public promptForDebug(): void {
    let defaultVal: string = this.config.get('wakatime.debug') || '';
    if (!defaultVal || defaultVal !== 'true') defaultVal = 'false';
    let items: string[] = ['true', 'false'];
    let promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal == null) return;
      this.config.update('wakatime.debug', newVal);
      if (newVal === 'true') {
        this.logger.setLevel(LogLevel.DEBUG);
        this.logger.debug('Debug enabled');
      } else {
        this.logger.setLevel(LogLevel.INFO);
      }
    });
  }

  public promptToDisable(): void {
    const previousValue = this.disabled;
    let currentVal = this.config.get('wakatime.disabled');
    if (!currentVal || currentVal !== 'true') currentVal = 'false';
    let items: string[] = ['disable', 'enable'];
    const helperText = currentVal === 'true' ? 'disabled' : 'enabled';
    let promptOptions = {
      placeHolder: `disable or enable (extension is currently "${helperText}")`,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal !== 'enable' && newVal !== 'disable') return;
      this.disabled = newVal === 'disable';
      if (this.disabled != previousValue) {
        if (this.disabled) {
          this.config.update('wakatime.disabled', 'true');
          this.logger.debug('Extension disabled, will not report code stats to dashboard');
          this.dispose();
        } else {
          this.config.update('wakatime.disabled', 'false');
          this.initializeDependencies();
        }
      }
    });
  }

  public promptStatusBarIcon(): void {
    let defaultVal: string = this.config.get('wakatime.status_bar_enabled') || '';
    if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
    let items: string[] = ['true', 'false'];
    let promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal !== 'true' && newVal !== 'false') return;
      this.config.update('wakatime.status_bar_enabled', newVal);
      this.showStatusBar = newVal === 'true'; // cache setting to prevent reading from disc too often
      this.setStatusBarVisibility(this.showStatusBar);
    });
  }

  public promptStatusBarCodingActivity(): void {
    let defaultVal: string = this.config.get('wakatime.status_bar_coding_activity') || '';
    if (!defaultVal || defaultVal !== 'false') defaultVal = 'true';
    let items: string[] = ['true', 'false'];
    let promptOptions = {
      placeHolder: `true or false (current value \"${defaultVal}\")`,
      value: defaultVal,
      ignoreFocusOut: true,
    };
    vscode.window.showQuickPick(items, promptOptions).then((newVal) => {
      if (newVal !== 'true' && newVal !== 'false') return;
      this.config.update('wakatime.status_bar_coding_activity', newVal);
      if (newVal === 'true') {
        this.logger.debug('Coding activity in status bar has been enabled');
        this.showCodingActivity = true;
        this.getCodingActivity();
      } else {
        this.logger.debug('Coding activity in status bar has been disabled');
        this.showCodingActivity = false;
        if (!this.statusBarShowingError()) {
          this.updateStatusBarText();
        }
      }
    });
  }

  public openDashboardWebsite(): void {
    let url = 'https://zeedas.com/';
    vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private checkApiKey(): void {
    this.hasApiKey((hasApiKey) => {
      if (!hasApiKey) this.promptForApiKey();
    });
  }

  private hasApiKey(callback: (arg0: boolean) => void): void {
    const apiKey: string = this.config.get('wakatime.apiKey') || '';
    callback(!Utils.apiKeyInvalid(apiKey));
  }

  private setStatusBarVisibility(isVisible: boolean): void {
    if (isVisible) {
      this.statusBar?.show();
      this.statusBarTeamYou?.show();
      this.statusBarTeamOther?.show();
      this.logger.debug('Status bar icon enabled.');
    } else {
      this.statusBar?.hide();
      this.statusBarTeamYou?.hide();
      this.statusBarTeamOther?.hide();
      this.logger.debug('Status bar icon disabled.');
    }
  }

  private setupEventListeners(): void {
    // subscribe to selection change and editor activation events
    let subscriptions: vscode.Disposable[] = [];
    vscode.window.onDidChangeTextEditorSelection(this.onChange, this, subscriptions);
    vscode.window.onDidChangeActiveTextEditor(this.onChange, this, subscriptions);
    vscode.workspace.onDidSaveTextDocument(this.onSave, this, subscriptions);

    vscode.tasks.onDidStartTask(this.onDidStartTask, this, subscriptions);
    vscode.tasks.onDidEndTask(this.onDidEndTask, this, subscriptions);

    vscode.debug.onDidChangeActiveDebugSession(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidChangeBreakpoints(this.onDebuggingChanged, this, subscriptions);
    vscode.debug.onDidStartDebugSession(this.onDidStartDebugSession, this, subscriptions);
    vscode.debug.onDidTerminateDebugSession(this.onDidTerminateDebugSession, this, subscriptions);

    // create a combined disposable for all event subscriptions
    this.disposable = vscode.Disposable.from(...subscriptions);
  }

  private onDebuggingChanged(): void {
    this.onEvent(false);
  }

  private onDidStartDebugSession(): void {
    this.isDebugging = true;
    this.onEvent(false);
  }

  private onDidTerminateDebugSession(): void {
    this.isDebugging = false;
    this.onEvent(false);
  }

  private onDidStartTask(e: vscode.TaskStartEvent): void {
    if (e.execution.task.isBackground) return;
    if (e.execution.task.detail && e.execution.task.detail.indexOf('watch') !== -1) return;
    this.isCompiling = true;
    this.onEvent(false);
  }

  private onDidEndTask(): void {
    this.isCompiling = false;
    this.onEvent(false);
  }

  private onChange(): void {
    this.onEvent(false);
  }

  private onSave(): void {
    this.onEvent(true);
  }

  private onEvent(isWrite: boolean): void {
    clearTimeout(this.debounceTimeoutId);
    this.debounceTimeoutId = setTimeout(() => {
      if (this.disabled) return;
      let editor = vscode.window.activeTextEditor;
      if (editor) {
        let doc = editor.document;
        if (doc) {
          doc.languageId;
          let file: string = doc.fileName;
          if (file) {
            if (this.currentlyFocusedFile !== file) {
              this.updateTeamStatusBarFromJson();
              this.updateTeamStatusBar(doc);
            }

            let time: number = Date.now();
            if (
              isWrite ||
              this.enoughTimePassed(time) ||
              this.lastFile !== file ||
              this.lastDebug !== this.isDebugging ||
              this.lastCompile !== this.isCompiling
            ) {
              this.sendHeartbeat(
                doc,
                time,
                editor.selection.start,
                isWrite,
                this.isCompiling,
                this.isDebugging,
              );
              this.lastFile = file;
              this.lastHeartbeat = time;
              this.lastDebug = this.isDebugging;
              this.lastCompile = this.isCompiling;
            }
          }
        }
      }
    }, this.debounceMs);
  }

  private sendHeartbeat(
    doc: vscode.TextDocument,
    time: number,
    selection: vscode.Position,
    isWrite: boolean,
    isCompiling: boolean,
    isDebugging: boolean,
  ): void {
    this.hasApiKey((hasApiKey) => {
      if (hasApiKey) {
        this._sendHeartbeat(doc, time, selection, isWrite, isCompiling, isDebugging);
      } else {
        this.promptForApiKey();
      }
    });
  }

  private async _sendHeartbeat(
    doc: vscode.TextDocument,
    time: number,
    selection: vscode.Position,
    isWrite: boolean,
    isCompiling: boolean,
    isDebugging: boolean,
  ) {
    let file = doc.fileName;
    if (Utils.isRemoteUri(doc.uri)) {
      file = `${doc.uri.authority}${doc.uri.path}`;
      file = file.replace('ssh-remote+', 'ssh://');
      // TODO: how to support 'dev-container', 'attached-container', 'wsl', and 'codespaces' schemes?
    }

    // prevent sending the same heartbeat (https://github.com/zeedas/vscode/issues/163)
    if (isWrite && this.isDuplicateHeartbeat(file, time, selection)) return;

    const payload = {
      type: 'file',
      entity: file,
      time: Date.now() / 1000,
      plugin: this.agentName + '/' + vscode.version + ' vscode-zeedas/' + this.extension.version,
      lineno: String(selection.line + 1),
      cursorpos: String(selection.character + 1),
      lines: String(doc.lineCount),
      is_write: isWrite,
    };

    const project = this.getProjectName();
    if (project) payload['project'] = project;

    const language = this.getLanguage(doc);
    if (language) payload['language'] = language;

    const folder = this.getProjectFolder(doc.uri);
    if (folder && file.indexOf(folder) === 0) {
      payload['project_root_count'] = this.countSlashesInPath(folder);
    }

    if (isDebugging) {
      payload['category'] = 'debugging';
    } else if (isCompiling) {
      payload['category'] = 'building';
    } else if (Utils.isPullRequest(doc.uri)) {
      payload['category'] = 'code reviewing';
    }

    this.logger.debug(`Sending heartbeat: ${JSON.stringify(payload)}`);

    const apiKey = this.config.get('wakatime.apiKey');
    const url = `https://plugin-staging.zeedas.com/api/v1/users/current/heartbeats?api_key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            this.agentName + '/' + vscode.version + ' vscode-zeedas/' + this.extension.version,
        },
        body: JSON.stringify(payload),
      });
      const parsedJSON = await response.json();
      if (response.status == 200 || response.status == 201 || response.status == 202) {
        if (this.showStatusBar) this.getCodingActivity();
      } else {
        this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
        if (response && response.status == 401) {
          let error_msg = 'Invalid Zeedas Beta Api Key';
          if (this.showStatusBar) {
            this.updateStatusBarText('ZeedasBeta Error');
            this.updateStatusBarTooltip(`Zeedas: ${error_msg}`);
          }
          this.logger.error(error_msg);
        } else {
          let error_msg = `Error sending heartbeat (${response.status}); Check your browser console for more details.`;
          if (this.showStatusBar) {
            this.updateStatusBarText('ZeedasBeta Error');
            this.updateStatusBarTooltip(`Zeedas: ${error_msg}`);
          }
          this.logger.error(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`API Error: ${ex}`);
      let error_msg = `Error sending heartbeat; Check your browser console for more details.`;
      if (this.showStatusBar) {
        this.updateStatusBarText('ZeedasBeta Error');
        this.updateStatusBarTooltip(`Zeedas: ${error_msg}`);
      }
      this.logger.error(error_msg);
    }
  }

  private getCodingActivity() {
    if (!this.showStatusBar) return;

    const cutoff = Date.now() - this.fetchTodayInterval;
    if (this.lastFetchToday > cutoff) return;

    this.lastFetchToday = Date.now();

    this.hasApiKey((hasApiKey) => {
      if (!hasApiKey) return;
      this._getCodingActivity();
    });
  }

  private async _getCodingActivity() {
    this.logger.debug('Fetching coding activity for Today from api.');
    const apiKey = this.config.get('wakatime.apiKey');
    const url = `https://plugin-staging.zeedas.com/api/v1/users/current/statusbar/today?api_key=${apiKey}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            this.agentName + '/' + vscode.version + ' vscode-zeedas/' + this.extension.version,
        },
      });
      const parsedJSON = await response.json();
      if (response.status == 200) {
        this.config.get('wakatime.status_bar_coding_activity');
        if (this.showStatusBar) {
          if (parsedJSON.data) this.hasTeamFeatures = parsedJSON.data.has_team_features;
          let output = parsedJSON.data.grand_total.text;
          if (
            this.config.get('wakatime.status_bar_hide_categories') != 'true' &&
            parsedJSON.data.categories.length > 1
          ) {
            output = parsedJSON.data.categories.map((x) => x.text + ' ' + x.name).join(', ');
          }
          if (output && output.trim()) {
            if (this.showCodingActivity) {
              this.updateStatusBarText(output.trim());
              this.updateStatusBarTooltip(
                'ZeedasBeta: Today’s coding time. Click to visit dashboard.',
              );
            } else {
              this.updateStatusBarText();
              this.updateStatusBarTooltip(output.trim());
            }
          } else {
            this.updateStatusBarText();
            this.updateStatusBarTooltip('ZeedasBeta: Calculating time spent today in background...');
          }
          this.updateTeamStatusBar();
        }
      } else {
        this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
        if (response && response.status == 401) {
          let error_msg = 'Invalid Zeedas Beta Api Key';
          if (this.showStatusBar) {
            this.updateStatusBarText('ZeedasBeta Error');
            this.updateStatusBarTooltip(`Zeedas: ${error_msg}`);
          }
          this.logger.error(error_msg);
        } else {
          let error_msg = `Error fetching code stats for status bar (${response.status}); Check your browser console for more details.`;
          this.logger.debug(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`API Error: ${ex}`);
    }
  }

  private async updateTeamStatusBar(doc?: vscode.TextDocument) {
    if (!this.showStatusBarTeam) return;
    if (!this.hasTeamFeatures) return;

    if (!doc) {
      doc = vscode.window.activeTextEditor?.document;
      if (!doc) return;
    }

    let file = doc.fileName;
    if (Utils.isRemoteUri(doc.uri)) {
      file = `${doc.uri.authority}${doc.uri.path}`;
      file = file.replace('ssh-remote+', 'ssh://');
      // TODO: how to support 'dev-container', 'attached-container', 'wsl', and 'codespaces' schemes?
    }

    this.currentlyFocusedFile = file;

    if (this.teamDevsForFileCache[file]) {
      this.updateTeamStatusBarFromJson(this.teamDevsForFileCache[file]);
      return;
    }

    this.logger.debug('Fetching devs for currently focused file from api.');
    const apiKey = this.config.get('wakatime.apiKey');
    const url = `https://plugin-staging.zeedas.com/api/v1/users/current/file_experts?api_key=${apiKey}`;

    const payload = {
      entity: file,
      plugin: this.agentName + '/' + vscode.version + ' vscode-zeedas/' + this.extension.version,
    };

    const project = this.getProjectName();
    if (!project) return;
    payload['project'] = project;

    const folder = this.getProjectFolder(doc.uri);
    if (!folder || file.indexOf(folder) !== 0) return;
    payload['project_root_count'] = this.countSlashesInPath(folder);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            this.agentName + '/' + vscode.version + ' vscode-zeedas/' + this.extension.version,
        },
        body: JSON.stringify(payload),
      });
      const parsedJSON = await response.json();
      if (response.status == 200) {
        const devs = {
          you: null,
          other: null,
        };
        if (parsedJSON.data) {
          const currentUser = parsedJSON.data.find((dev) => dev.user.is_current_user);
          let topDev = parsedJSON.data[0];
          if (topDev.user.is_current_user) {
            if (parsedJSON.data.length > 1) {
              topDev = parsedJSON.data[1];
            } else {
              topDev = null;
            }
          }

          devs.you = currentUser;
          devs.other = topDev;
          this.teamDevsForFileCache[file] = devs;
        }

        // make sure this file is still the currently focused file
        if (file !== this.currentlyFocusedFile) return;

        this.config.get('wakatime.status_bar_coding_activity');
        if (this.showStatusBar) {
          this.updateTeamStatusBarFromJson(devs);
        }
      } else {
        this.updateTeamStatusBarTextForCurrentUser();
        this.updateTeamStatusBarTextForOther();
        this.logger.warn(`API Error ${response.status}: ${parsedJSON}`);
        if (response && response.status == 401) {
          this.logger.error('Invalid Zeedas Beta Api Key');
        } else {
          let error_msg = `Error fetching devs for currently focused file (${response.status}); Check your browser console for more details.`;
          this.logger.debug(error_msg);
        }
      }
    } catch (ex) {
      this.logger.warn(`API Error: ${ex}`);
    }
  }

  private updateTeamStatusBarFromJson(jsonData?: any) {
    if (!jsonData) {
      this.updateTeamStatusBarTextForCurrentUser();
      this.updateTeamStatusBarTextForOther();
      return;
    }

    const you = jsonData.you;
    const other = jsonData.other;

    if (you) {
      this.updateTeamStatusBarTextForCurrentUser('You: ' + you.total.text);
      this.updateStatusBarTooltipForCurrentUser('Your total time spent in this file');
    } else {
      this.updateTeamStatusBarTextForCurrentUser();
    }
    if (other) {
      this.updateTeamStatusBarTextForOther(other.user.name + ': ' + other.total.text);
      this.updateStatusBarTooltipForOther(
        other.user.long_name + '’s total time spent in this file',
      );
    } else {
      this.updateTeamStatusBarTextForOther();
    }
  }

  private enoughTimePassed(time: number): boolean {
    return this.lastHeartbeat + 120000 < time;
  }

  private isDuplicateHeartbeat(file: string, time: number, selection: vscode.Position): boolean {
    let duplicate = false;
    let minutes = 30;
    let milliseconds = minutes * 60000;
    if (
      this.dedupe[file] &&
      this.dedupe[file].lastHeartbeatAt + milliseconds < time &&
      this.dedupe[file].selection.line == selection.line &&
      this.dedupe[file].selection.character == selection.character
    ) {
      duplicate = true;
    }
    this.dedupe[file] = {
      selection: selection,
      lastHeartbeatAt: time,
    };
    return duplicate;
  }

  private getLanguage(doc: vscode.TextDocument): string {
    return doc.languageId || '';
  }

  private getProjectName(): string {
    return vscode.workspace.name || '';
  }

  private getProjectFolder(uri: vscode.Uri): string {
    if (!vscode.workspace) return '';
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      try {
        return workspaceFolder.uri.fsPath;
      } catch (e) {}
    }
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
      return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }
    return '';
  }

  private countSlashesInPath(path: string): number {
    if (!path) return 0;

    const windowsNetDrive = path.indexOf('\\\\') === 0;

    path = path.replace(/[\\/]+/, '/');

    if (windowsNetDrive) {
      path = '\\\\' + path.slice(1);
    }

    if (!path.endsWith('/')) path = path + '/';

    return (path.match(/\//g) || []).length;
  }
}
