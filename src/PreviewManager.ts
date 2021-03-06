"use strict"
import {PythonEvaluator} from "arepl-backend"
import {EOL} from "os"
import { isAbsolute, sep } from "path";
import * as vscode from "vscode"
import { PreviewContainer } from "./previewContainer";
import Reporter from "./telemetry"
import {ToAREPLLogic} from "./toAREPLLogic"
import vscodeUtils from "./vscodeUtilities";
import { PythonShell } from "python-shell";
import {settings} from "./settings"

/**
 * class with logic for starting arepl and arepl preview
 */
export default class PreviewManager {

    reporter: Reporter;
    disposable: vscode.Disposable;
    pythonEditorDoc: vscode.TextDocument;
    pythonEvaluator: PythonEvaluator;
    runningStatus: vscode.StatusBarItem;
    toAREPLLogic: ToAREPLLogic
    previewContainer: PreviewContainer
    subscriptions: vscode.Disposable[] = []
    highlightDecorationType: vscode.TextEditorDecorationType
    pythonEditor: vscode.TextEditor;

    /**
     * assumes a text editor is already open - if not will error out
     */
    constructor(context: vscode.ExtensionContext) {
        this.runningStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.runningStatus.text = "Running python..."
        this.runningStatus.tooltip = "AREPL is currently running your python file.  Close the AREPL preview to stop"
        this.reporter = new Reporter(settings().get<boolean>("telemetry"))
        this.previewContainer = new PreviewContainer(this.reporter, context)

        this.highlightDecorationType = vscode.window.createTextEditorDecorationType(<vscode.ThemableDecorationRenderOptions>{
            backgroundColor: 'yellow'
        })
    }

    async startArepl(){
        // reload reporter (its disposed when arepl is closed)
        this.reporter = new Reporter(settings().get<boolean>("telemetry"))

        if(!vscode.window.activeTextEditor){
            vscode.window.showErrorMessage("no active text editor open")
            return
        }
        this.pythonEditor = vscode.window.activeTextEditor
        this.pythonEditorDoc = this.pythonEditor.document
        
        let panel = this.previewContainer.start();
        this.subscriptions.push(panel)
        panel.onDidDispose(()=>this.dispose(), this, this.subscriptions)

        this.startAndBindPython()

        if(this.pythonEditorDoc.isUntitled && this.pythonEditorDoc.getText() == "") {
            await this.insertDefaultImports(this.pythonEditor)
            // waiting for this to complete so i dont accidentily trigger
            // the edit doc handler when i insert imports
        }

        this.subscribeHandlersToDoc()

        return panel
    }

    runArepl(){
        this.onAnyDocChange(this.pythonEditorDoc)
    }

    runAreplBlock() {
        const editor = vscode.window.activeTextEditor
        const selection = editor.selection
        let block:vscode.Range = null;

        if(selection.isEmpty){ // just a cursor
            block = vscodeUtils.getBlockOfText(editor, selection.start.line)
        }
        else{
            block = new vscode.Range(selection.start, selection.end)
        }
           
        let codeLines = editor.document.getText(block)
        // hack: we want accurate line # info
        // so we prepend lines to put codeLines in right spot
        codeLines = vscodeUtils.eol(editor.document).repeat(block.start.line) + codeLines
        const filePath = editor.document.isUntitled ? "" : editor.document.fileName
        const data = {
            evalCode: codeLines,
            filePath,
            savedCode: '',
            usePreviousVariables: true,
            showGlobalVars: settings().get<boolean>('showGlobalVars')
        }
        this.pythonEvaluator.execCode(data)
        this.runningStatus.show()

        if(editor){
            editor.setDecorations(this.highlightDecorationType, [block])
        }

        setTimeout(()=>{
            // clear decorations
            editor.setDecorations(this.highlightDecorationType, [])
        }, 100)
    }

    dispose() {
        if(this.pythonEvaluator.pyshell != null && this.pythonEvaluator.pyshell.childProcess != null){
            this.pythonEvaluator.stop()
        }

        this.disposable = vscode.Disposable.from(...this.subscriptions);
        this.disposable.dispose();

        this.runningStatus.dispose();
        
        this.reporter.sendFinishedEvent(settings())
        this.reporter.dispose();

        if(vscode.window.activeTextEditor){
            vscode.window.activeTextEditor.setDecorations(this.previewContainer.errorDecorationType, [])
        }
    }

    getPythonPath(){
        let pythonPath = settings().get<string>("pythonPath")

        const pythonExtSettings = vscode.workspace.getConfiguration("python", null);
        const pythonExtPythonPath = pythonExtSettings.get<string>('pythonPath')
        if(pythonExtPythonPath && !pythonPath) pythonPath = pythonExtPythonPath

        if(pythonPath){
            pythonPath = pythonPath.replace("${workspaceFolder}", vscodeUtils.getCurrentWorkspaceFolder())

            let envVar = pythonPath.match(/\${env:([^}]+)}/)
            if(envVar){
                pythonPath = pythonPath.replace(envVar[1], process.env[envVar[1]])
            }

            // not needed anymore but here for backwards compatability. Remove in 2020
            pythonPath = pythonPath.replace("${python.pythonPath}", pythonExtSettings.get('pythonPath'))

            // if its a relative path, make it absolute
            if(pythonPath.includes(sep) && !isAbsolute(pythonPath)){
                pythonPath = vscodeUtils.getCurrentWorkspaceFolder() + sep + pythonPath
            }
        }
        else{
            pythonPath = PythonShell.defaultPythonPath
        }

        return pythonPath
    }

    /**
     * starts AREPL python backend and binds print&result output to the handlers
     */
    private startAndBindPython(){
        const pythonPath = this.getPythonPath()
        const pythonOptions = settings().get<string[]>("pythonOptions")

        PythonShell.getVersion(`"${pythonPath}"`).then((out)=>{
            if(out.stdout){
                if(out.stdout.includes("Python 2.")){
                    vscode.window.showErrorMessage("AREPL does not support python 2!")
                }
            }
        }).catch((s:Error)=>{
            // if we get spawn error here thats already reported by telemetry
            // so we skip telemetry reporting for this error
            console.error(s)
        })

        this.pythonEvaluator = new PythonEvaluator(pythonPath, pythonOptions)
        
        try {
            this.pythonEvaluator.startPython()
        } catch (err) {
            if (err instanceof Error){
                const error = `Error running python with command: ${pythonPath} ${pythonOptions.join(' ')}\n${err.stack}`
                this.previewContainer.displayProcessError(error);
                // @ts-ignore 
                this.reporter.sendError(err.name+' '+err.message, err.stack, error.errno, 'spawn')            
            }
            else{
                console.error(err)
            }
        }
        this.pythonEvaluator.pyshell.childProcess.on("error", err => {
            /* The 'error' event is emitted whenever:
            The process could not be spawned, or
            The process could not be killed, or
            Sending a message to the child process failed.
            */

            // @ts-ignore err is actually SystemError but node does not type it
            const error = `Error running python with command: ${err.path} ${err.spawnargs.join(' ')}\n${err.stack}`
            this.previewContainer.displayProcessError(error);
            // @ts-ignore 
            this.reporter.sendError(err.code, err.stack, error.errno, 'spawn')
        })
        this.pythonEvaluator.pyshell.childProcess.on("exit", err => {
            /* The 'exit' event is emitted after the child process ends */
            // that's what node doc CLAIMS ..... 
            // but when i debug this never gets called unless there's a unexpected error :/
            
            if(!err) return // normal exit
            const error = `AREPL crashed unexpectedly! Are you using python 3? err: ${err}`
            this.previewContainer.displayProcessError(error);
            this.reporter.sendError('exit', null, err, 'spawn')
        })

        this.toAREPLLogic = new ToAREPLLogic(this.pythonEvaluator, this.previewContainer)

        // binding this to the class so it doesn't get overwritten by PythonEvaluator
        this.pythonEvaluator.onPrint = this.previewContainer.handlePrint.bind(this.previewContainer)
        // this is bad - stderr should be handled seperately so user is aware its different
        // but better than not showing stderr at all, so for now printing it out and ill fix later
        this.pythonEvaluator.onStderr = this.previewContainer.handlePrint.bind(this.previewContainer)
        this.pythonEvaluator.onResult = result => {
            this.runningStatus.hide()
            this.previewContainer.handleResult(result)
        }
    }

    /**
     * binds various funcs to activate upon edit of document / switching of active doc / etc...
     */
    private subscribeHandlersToDoc(){

        if(settings().get<boolean>("skipLandingPage")){
            this.onAnyDocChange(this.pythonEditorDoc);
        }

        
        vscode.workspace.onDidSaveTextDocument((e) => {
            if(settings().get<string>("whenToExecute") == "onSave"){
                this.onAnyDocChange(e)
            }
        }, this, this.subscriptions)
        
        vscode.workspace.onDidChangeTextDocument((e) => {
            if(settings().get<string>("whenToExecute") == "afterDelay"){
                let delay = settings().get<number>("delay");
                const restartExtraDelay = settings().get<number>("restartDelay");
                delay += this.toAREPLLogic.restartMode ? restartExtraDelay : 0
                this.pythonEvaluator.debounce(this.onAnyDocChange.bind(this, e.document), delay)
            }
        }, this, this.subscriptions)
        
        vscode.workspace.onDidCloseTextDocument((e) => {
            if(e == this.pythonEditorDoc) this.dispose()
        }, this, this.subscriptions)
    }

    private insertDefaultImports(editor: vscode.TextEditor){
        return editor.edit((editBuilder) => {
            let imports = settings().get<string[]>("defaultImports")

            imports = imports.filter(i => i.trim() != "")
            if(imports.length == 0) return

            imports = imports.map(i => {
                const words = i.split(" ")

                // python import syntax: "import library" or "from library import method"
                // so if user didnt specify import we will do that for them :)
                if(words[0] != "import" && words[0] != "from" && words[0].length > 0){
                    i = "import " + i
                }

                return i
            })

            editBuilder.insert(new vscode.Position(0, 0), imports.join(EOL) + EOL)
        })
    }

    private onAnyDocChange(event: vscode.TextDocument){
        if(event == this.pythonEditorDoc){

            this.reporter.numRuns += 1
            if(this.pythonEvaluator.evaling){
                this.reporter.numInterruptedRuns += 1
            }

            const text = event.getText()
            const filePath = this.pythonEditorDoc.isUntitled ? "" : this.pythonEditorDoc.fileName
            const codeRan = this.toAREPLLogic.onUserInput(text, filePath, vscodeUtils.eol(event), settings().get<boolean>('showGlobalVars'))
            if(codeRan) this.runningStatus.show();
        }        
    }
}
