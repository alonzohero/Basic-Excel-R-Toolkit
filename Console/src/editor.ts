/// <reference path="../node_modules/monaco-editor/monaco.d.ts" />

import {remote} from 'electron';

import { MenuUtilities } from './menu_utilities';
import * as JuliaLanguage from './julia-language';
import { TabPanel, TabJustify, TabEventType, TabSpec } from './tab-panel';

const Constants = require( "../data/constants.json");

import * as path from 'path';
import * as fs from 'fs';
import * as Rx from 'rxjs';

// ambient, declared in html
declare const amd_require: any;

/**
 * class represents a document in the editor; has content, view state
 */
class Document {

  /** label: the file name, generally, or "untitled-x" */
  label_:string;

  /** path to file. null for "new" files that have never been saved. */
  file_path_:string;

  /** editor model */
  model_:monaco.editor.IModel;

  /** preserved state on tab switches */
  view_state_:monaco.editor.ICodeEditorViewState;

  /** flag */
  dirty_ = false;

  /** the last saved version, for comparison to AVID, for dirty check */
  saved_version_ = 0; // last saved version ID

  /** local ID */
  id_: number;

  /** serialize */
  toJSON(){
    return {
      label: this.label_,
      file_path: this.file_path_,
      view_state: this.view_state_,
      dirty: this.dirty_,
      saved_version: this.saved_version_,
      alternative_version_id: this.model_.getAlternativeVersionId(),
      text: this.model_.getValue()
    }
  }

}

/**
 * 
 */
class EditorStatusBar {

  /** main status bar node */
  private node_:HTMLElement;

  /** text, left side */
  private label_:HTMLElement;

  /** line/col (right side) */
  private position_:HTMLElement;

  /** language (right side) */
  private language_:HTMLElement;

  /** accessor */
  public get node() { return this.node_; }

  /** accessor for content, not node */
  public set label(text){ this.label_.textContent = text; }
  
  /** accessor for content, not node */
  public set language(text){ this.language_.textContent = text; }

  /** accessor for content, not node: pass [line, col] */
  public set position([line, column]){ 
    if( null === line || null === column ) {
      this.position_.textContent = "";
    }
    else {
      this.position_.textContent = `${Constants.status.line} ${line}, ${Constants.status.column} ${column}`;
    }
  }

  constructor(){

    this.node_ = document.createElement("div");
    this.node_.classList.add("editor-status-bar");

    this.label_ = document.createElement("div");
    this.node_.appendChild(this.label_);

    // this node has flex-grow=1 to push other nodes to left and right
    let spacer = document.createElement("div");
    spacer.classList.add("spacer");
    this.node_.appendChild(spacer);

    this.position_ = document.createElement("div");
    this.node_.appendChild(this.position_);

    this.language_ = document.createElement("div");
    this.node_.appendChild(this.language_);

  }

}

/**
 * class represents an editor; handles its own layout. basically a wrapper
 * for monaco, adding document handling plus any customization we want to do.
 * 
 * monaco doesn't work as a module, so it requires some html markup and 
 * some extra loading, but once that's done we can treat it as a regular 
 * type (using the reference).
 */
export class Editor {

  /** flag for loading, in case we have multiple instances */
  static loaded_ = false;

  /** utility function */
  static UriFromPath(_path) {
    var pathName = path.resolve(_path).replace(/\\/g, '/');
    if (pathName.length > 0 && pathName.charAt(0) !== '/') {
      pathName = '/' + pathName;
    }
    return encodeURI('file://' + pathName);
  }

  /**
   * finish loading monaco
   */
  static Load() : Promise<void> {

    if(this.loaded_) return Promise.resolve();
    return new Promise((resolve, reject) => {

      this.loaded_ = true;

      // see monaco electron sample for this

      amd_require.config({
        baseUrl: Editor.UriFromPath(path.join(__dirname, '../node_modules/monaco-editor/min'))
      });
      self['module'] = undefined;
      self['process'].browser = true;

      // this is async
      amd_require(['vs/editor/editor.main'], () => {

        // register additional languages (if any)
        // TODO: abstract this

        let conf = { id: 'julia', extensions: ['.jl', '.julia'] };
        monaco.languages.register(conf);    
        monaco.languages.onLanguage(conf.id, () => {
          monaco.languages.setMonarchTokensProvider(conf.id, JuliaLanguage.language);
          monaco.languages.setLanguageConfiguration(conf.id, JuliaLanguage.conf);
        });

        resolve();

      });
    });

  }

  private status_bar_ = new EditorStatusBar();

  /** editor instance */
  private editor_: monaco.editor.IStandaloneCodeEditor;

  /** tab panel */
  private tabs_: TabPanel;

  /** html element containing editor */
  private container_: HTMLElement;

  /** properties */
  private properties_: any;

  /** list of open documents */
  // private documents_:Document[] = [];

  /** reference */
  private active_document_:Document;

  /** reference */
  private active_tab_:TabSpec;

  /** 
   * monotonically increment "Untitled-X" documents. by convention starts at 1.
   */
  private untitled_id_generator_ = 1;

  /** internal document IDs need to be unique, but no other constraints */
  private document_id_generator = 0;

  /**
   * builds layout, does any necessary initialization and then instantiates 
   * the editor instance
   * 
   * @param node an element, or a selector we can pass to `querySelector()`.
   */
  constructor(node: string | HTMLElement, properties: any) {

    this.properties_ = properties;

    if (typeof node === "string") this.container_ = document.querySelector(node);
    else this.container_ = node;

    this.container_.classList.add("editor-container");

    let tabs = document.createElement("div");
    tabs.classList.add("editor-tabs");
    this.container_.appendChild(tabs);

    let editor = document.createElement("div");
    editor.classList.add("editor-editor");
    tabs.appendChild(editor);

    this.container_.appendChild(this.status_bar_.node);
    this.status_bar_.label = Constants.status.ready;

    this.tabs_ = new TabPanel(tabs);
   
    this.tabs_.events.filter(event => event.type === TabEventType.deactivate ).subscribe(event => {
      this.DeactivateTab(event.tab);
    });
    
    this.tabs_.events.filter(event => event.type === TabEventType.activate ).subscribe(event => {
      this.ActivateTab(event.tab);
    });

    /*
    editor_tabs.events.filter(x => x.type === TabEventType.rightClick ).subscribe(x => {
      console.info("RC!", x);
    })
    */
    
    this.tabs_.events.filter(x => x.type === TabEventType.buttonClick ).subscribe(event => {
      this.CloseTab(event.tab);
    });

    // the load call ensures monaco is loaded via the amd loader;
    // if it's already been loaded once this will return immediately
    // via Promise.resolve().

    // FIXME: options

    Editor.Load().then(() => {
      this.editor_ = monaco.editor.create(editor, {
        model: null, // don't create an empty model
        lineNumbers: "on",
        roundedSelection: true,
        scrollBeyondLastLine: false,
        readOnly: false,
        minimap: { enabled: false },
        // theme: "vs-dark",
      });

      // cursor position -> status bar
      this.editor_.onDidChangeCursorPosition(event => {
        this.status_bar_.position = [event.position.lineNumber, event.position.column];
      });

      // watch dirty
      this.editor_.onDidChangeModelContent(event => {
        let dirty = (this.active_document_.saved_version_ !== this.active_document_.model_.getAlternativeVersionId());

        // dirty is in two places now? FIXME
        if( dirty !== this.active_tab_.dirty ){
          this.active_tab_.dirty = dirty;
          this.active_document_.dirty_ = dirty;
          this.tabs_.UpdateTab(this.active_tab_);
        }

        this.CacheDocument();

      });

      this.RestoreOpenFiles();

    });

    MenuUtilities.events.subscribe(event => {
      switch(event.id){
      case "main.file.open-file":
        this.OpenFile();
        break;
      case "main.file.close-file":
        this.CloseTab(this.active_tab_);
        break;
      case "main.file.save-file":
        this.SaveTab(this.active_tab_);
        break;
      case "main.file.save-file-as":
        this.SaveTab(this.active_tab_, true);
        break;
      case "main.file.new-file":
        this.NewFile();
        break;
      case "main.file.revert-file":
        this.RevertFile();
        break;
      case "main.file.open-recent.open-recent-file":
        this.OpenFile(event.item.data);
        break;
      }
    });

    MenuUtilities.loaded.filter(x => x).first().subscribe(() => this.UpdateRecentFilesList());

  }

  /** 
   * utility for ~unique hashes (uses the java string algorithm). NOT SECURE! 
   */
  private static Hash(text){
    let hash = 0;
    let length = text.length;
    if (length > 0) {
      for (let i = 0; i < length; i++) {
        let char = text.charCodeAt(i);
        hash = ((hash<<5)-hash) + char;
        hash = hash & hash; 
      }
    }
    return hash;
  }

  private CacheDocument(document:Document = this.active_document_){
    localStorage.setItem(`cached-document-${document.id_}`, JSON.stringify(document));
  }

  /** 
   * ensure the list of open files is synced with open files. this 
   * can get called when a new file is opened or when a file is 
   * closed.
   */
  private UpdateOpenFiles(){
  
    let open_files:number[] = this.properties_.open_files || [];
    let new_list:number[] = [];

    this.tabs_.data.forEach( document => {
      if( undefined === open_files.find( x => (document.id_ === x))){
        console.info( "add file:", document );
        localStorage.setItem(`cached-document-${document.id_}`, JSON.stringify(document));
      }
      new_list.push(document.id_);
    });

    // something removed?
    open_files.forEach(check => {
      if( undefined === new_list.find( x => ( x === check ))){
        console.info( "remove", check);
        localStorage.removeItem(`cached-document-${check}`);
      }
    });

    this.properties_.open_files = new_list;
   
  }

  /**
   * 
   */
  private RestoreOpenFiles(){
    
    // there are two levels of storage for open files. there's a flat list,
    // and then there are items for each file.
    // 
    // we store each file separately so we don't have to re-serialize the whole
    // set every time, which seems unecessary. OTOH that means we have loose
    // items which can get orphaned, so we need to scrub them if they're not in
    // the list.

    let max_id = -1;
    let active_id = this.properties_.active_tab;
    let activate:TabSpec = null;

    (this.properties_.open_files || []).forEach(entry => {

      let key = `cached-document-${entry}`;
      let text = localStorage.getItem(key);

      if( text ){
        try {

          let unserialized = JSON.parse(text);
          let document = new Document();
          document.label_ = unserialized.label;
          document.file_path_ = unserialized.file_path;

          if(unserialized.file_path){
            document.model_ = monaco.editor.createModel(unserialized.text, undefined, 
              monaco.Uri.parse(Editor.UriFromPath(unserialized.file_path)));
          }
          else {
            document.model_ = monaco.editor.createModel(unserialized.text, "plaintext"); 
          }
  
          document.saved_version_ = document.model_.getAlternativeVersionId()
          document.id_ = entry; 
          document.dirty_ = !!unserialized.dirty;
          document.view_state_ = unserialized.view_state;

          if( document.dirty_ ) document.saved_version_--;

          max_id = Math.max(max_id, entry);
        
          let tab:TabSpec = {
            label: document.label_,
            tooltip: document.file_path_,
            closeable: true,
            button: true,
            dirty: document.dirty_,
            data: document
          };

          if(entry === active_id) activate = tab;
          this.tabs_.AddTabs(tab);
         
        }
        catch(e){
          console.error(e);
        }
      }
      else {
        console.info("NF", key);
      }
    });

    if(activate) this.tabs_.ActivateTab(activate);

    this.UpdateOpenFiles();
   
  }

  /** 
   * updates the menu item, on file open and on construct 
   * TODO: abbreviate super long paths with ellipses
   */
  private UpdateRecentFilesList(){
    let recent_files = this.properties_.recent_files||[];
    MenuUtilities.SetSubmenu("main.file.open-recent", recent_files.map( file_path => {
      return { label: file_path, id: "open-recent-file", data: file_path };
    }));
  }

  /** close tab (called on button click) */
  private CloseTab(tab:TabSpec){

    // FIXME: warn if dirty

    // FIXME: push on closed tab stack (FIXME: add closed tab stack)

    if( tab === this.active_tab_ ){
      if( this.tabs_.count > 1 ) this.tabs_.Next();
    }

    let document = tab.data as Document;

    this.tabs_.RemoveTab(tab);
    this.UpdateOpenFiles();

    document.model_.dispose();
    
  }

  /** deactivates tab and saves view state. */
  private DeactivateTab(tab:TabSpec){
    if( tab.data ){
      let document = tab.data as Document;
      document.view_state_ = this.editor_.saveViewState();
    }
  }

  /** 
   * activates tab, loads document and restores view state (if available) 
   * tab may be null if there are no tabs -- activate will get broadcast,
   * but with no data. 
   */
  private ActivateTab(tab:TabSpec){

    if(!tab){
      this.active_tab_ = null;
      this.active_document_ = null;
      this.editor_.setModel(null);
      this.status_bar_.language = "";
      this.status_bar_.position = [null, null];
      return;
    }

    this.active_tab_ = tab;

    if( tab.data ){
      let document = tab.data as Document;
      this.active_document_ = document;

      if( document.model_ ) {
        this.editor_.setModel(document.model_);
        if( document.view_state_) 
          this.editor_.restoreViewState(document.view_state_);
        let language = document.model_['_languageIdentifier'].language;
        language = language.substr(0,1).toUpperCase() + language.substr(1);
        this.status_bar_.language = language;
      }
      this.properties_.active_tab = document.id_;
    }

  }

  /**
   * force_dialog is for "save as", can also be used in any case you
   * don't necessarily want to overwrite.
   */
  public SaveTab(tab:TabSpec, force_dialog = false){

    let document = tab.data as Document;
    let file_path = document.file_path_;

    if(force_dialog||!file_path){
    
      // dialog
      
    }

    if(file_path){
      let contents = document.model_.getValue();
      fs.writeFile( file_path, contents, "utf8", err => {
        if(err) console.error(err);
        else {
          tab.dirty = document.dirty_ = false;
          document.saved_version_ = document.model_.getAlternativeVersionId();
          this.CacheDocument(document);
          this.tabs_.UpdateTab(tab);
        }
      });
    }
    
  }

  /** 
   * creates a new file. this is like opening a file, except that there's
   * no path, and no initial content. 
   */
  public NewFile(){
    return new Promise((resolve, reject) => {

      let document = new Document();
      document.label_ = `${Constants.files.untitled}-${this.untitled_id_generator_++}`;
      document.model_ = monaco.editor.createModel("", "plaintext");
      document.saved_version_ = document.model_.getAlternativeVersionId()
      document.id_ = this.document_id_generator++;

      let tab:TabSpec = {
        label: document.label_,
        // tooltip: file_path,
        closeable: true,
        button: true,
        dirty: false,
        data: document
      };

      this.tabs_.AddTabs(tab);
      this.tabs_.ActivateTab(tab);
      this.UpdateOpenFiles();

    });
  }


  /** load a file from a given path */
  private OpenFileInternal(file_path:string){

    // check if this file is already open (by path), switch to

    let current_tab = this.tabs_.tabs.find( tab => {
      return (tab.data && ((tab.data as Document).file_path_ === file_path));
    });

    if( current_tab ){
      this.tabs_.ActivateTab(current_tab);
      return Promise.resolve();
    }

    // not found, open

    return new Promise((resolve, reject) => {
      fs.readFile(file_path, "utf8", (err, data) => {
        if(err) return reject(err);

        let recent_files = (this.properties_.recent_files||[]).slice(0).filter( x => x !== file_path );
        recent_files.unshift(file_path);
        this.properties_.recent_files = recent_files;
        this.UpdateRecentFilesList();

        let document = new Document();
        document.label_ = path.basename(file_path),
        document.file_path_ = file_path;
        document.model_ = monaco.editor.createModel(data, undefined, 
          monaco.Uri.parse(Editor.UriFromPath(file_path)));

        document.saved_version_ = document.model_.getAlternativeVersionId()
        document.id_ = this.document_id_generator++;
      
        let tab:TabSpec = {
          label: document.label_,
          tooltip: file_path,
          closeable: true,
          button: true,
          dirty: false,
          data: document
        };

        this.tabs_.AddTabs(tab);
        this.tabs_.ActivateTab(tab);
        this.UpdateOpenFiles();

      });
    });
  }

  /** 
   * select and open file. if no path is passed, show a file chooser.
   */
  public OpenFile(file_path?:string){
    if(file_path) return this.OpenFileInternal(file_path);
    let files = remote.dialog.showOpenDialog({
      title: "Open File",
      properties: ["openFile"],
      filters: [
        {name: 'R source files', extensions: ['r', 'rsrc', 'rscript']},
        {name: 'All Files', extensions: ['*']}
      ]
    });
    if( files && files.length ) return this.OpenFileInternal(files[0]);
    return Promise.reject("no file selected");
  }

  public RevertFile(){}
  
  /** update layout, should be called after resize */
  public UpdateLayout() {
    if (this.editor_) this.editor_.layout();
  }

}

