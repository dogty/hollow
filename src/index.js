import "babel-polyfill"
import React, { Fragment } from "react"
import ReactDOM from "react-dom"
import { Encode, Decode, Hash, DownloadData, HumanTime, ProcessBulkFiles, DownloadZip, ExtractTarGz } from "./functions.js"
import JSZip from 'jszip'
import History from "./history.js"
import WindowDrag from "./windowDrag.js"
import "./style.css"

var history = new History()
var windowDrag = new WindowDrag()

class App extends React.Component {
    constructor(){
        super()
        this.fileInputRef = React.createRef()
        this.bulkFileInputRef = React.createRef()
        windowDrag.onDrop = e => {
            this.handleDragDrop(e)
        } 
        windowDrag.onDragEnter = () => this.setState({ dragging: true })
        windowDrag.onDragLeave = () => this.setState({ dragging: false })
    }
    state = {
        gameFile: "", 
        gameFileOriginal: "",
        editing: false,
        dragging: false,
        switchMode: false,
        bulkProcessing: false,
        bulkConvertToPC: true
    }
    handleFileClick = () => {
        this.fileInputRef.current.click()
    }
    handleFileChange = files => {
		if (files.length == 0){
			return 
		}
		
		let file = files[0]
		let reader = new FileReader()

		if (this.state.switchMode){
			reader.readAsText(file)
		} else {
			reader.readAsArrayBuffer(file)
		}

		reader.addEventListener("load", () => {
			var result = reader.result
			try {
				let decrypted = ""
				if (this.state.switchMode) {
					decrypted = result
				} else {
					decrypted = Decode(new Uint8Array(result))
				}
				var jsonString = JSON.stringify(JSON.parse(decrypted), undefined, 2)
				const hash = Hash(jsonString)
				history.removeFromHistory(hash)
				history.addToHistory(jsonString, file.name, hash)
				history.syncToLocalStorage()
				this.setGameFile(jsonString, file.name)
			} catch (err){
				window.alert("The file could not decrypted.")
				console.warn(err)
			} 
			this.fileInputRef.current.value = null
		})
    }
    handleEditorChange = e => {
        this.setState({gameFile: e.target.value})
    }
    handleReset = e => {
        this.setState({
            gameFile: this.state.gameFileOriginal
        }) 
    }
	handleDownloadAsSwitchSave = e => {
		try {
            var data = JSON.stringify(JSON.parse(this.state.gameFile))
            DownloadData(data, "plain.dat")
        } catch (err){
            window.alert("Could not parse valid JSON. Reset or fix.")
        }
    }
    handleDownload = e => {
        try {
            var data = JSON.stringify(JSON.parse(this.state.gameFile))
            var encrypted = Encode(data)
            DownloadData(encrypted, "user1.dat")
        } catch (err){
            window.alert("Could not parse valid JSON. Reset or fix.")
        }
    }
    setGameFile = (jsonString, name) => {
        jsonString = JSON.stringify(JSON.parse(jsonString), undefined, 2)
        this.setState({
            gameFile: jsonString,
            gameFileOriginal: jsonString,
            gameFileName: name, 
            editing: true 
        })
    }
    handleDragDrop = async (e) => {
        const items = e.dataTransfer.items
        const files = e.dataTransfer.files
        
        if (items && items.length > 0) {
            // Use the modern API to handle folders
            const allFiles = []
            
            for (let i = 0; i < items.length; i++) {
                const item = items[i]
                if (item.kind === 'file') {
                    const entry = item.webkitGetAsEntry()
                    if (entry) {
                        const extractedFiles = await this.extractFilesFromEntry(entry)
                        allFiles.push(...extractedFiles)
                    }
                }
            }
            
            if (allFiles.length > 0) {
                this.handleBulkFileChange(allFiles)
                return
            }
        }
        
        // Fallback to regular files
        if (files.length > 1 || 
            Array.from(files).some(f => f.name.endsWith('.dat')) ||
            Array.from(files).some(f => f.name.endsWith('.zip')) ||
            Array.from(files).some(f => f.name.endsWith('.tar.gz')) ||
            Array.from(files).some(f => f.name.endsWith('.tgz'))) {
            this.handleBulkFileChange(files)
        } else {
            this.handleFileChange(files)
        }
    }
    
    extractFilesFromEntry = (entry, basePath = '') => {
        return new Promise((resolve) => {
            const files = []
            
            if (entry.isFile) {
                entry.file(file => {
                    if (file.name.endsWith('.dat')) {
                        // Create a custom file object with path info
                        const fullPath = basePath ? `${basePath}/${file.name}` : file.name
                        const fileWithPath = {
                            name: file.name,
                            webkitRelativePath: fullPath,
                            size: file.size,
                            type: file.type,
                            lastModified: file.lastModified,
                            arrayBuffer: () => file.arrayBuffer(),
                            text: () => file.text()
                        }
                        files.push(fileWithPath)
                    }
                    resolve(files)
                })
            } else if (entry.isDirectory) {
                const dirReader = entry.createReader()
                dirReader.readEntries(entries => {
                    const newBasePath = basePath ? `${basePath}/${entry.name}` : entry.name
                    const promises = entries.map(subEntry => this.extractFilesFromEntry(subEntry, newBasePath))
                    Promise.all(promises).then(results => {
                        results.forEach(result => files.push(...result))
                        resolve(files)
                    })
                })
            } else {
                resolve(files)
            }
        })
    }
    
    handleBulkFileClick = () => {
        this.bulkFileInputRef.current.click()
    }
    handleBulkFileChange = async (files) => {
        if (files.length === 0) return
        
        this.setState({ bulkProcessing: true })
        
        try {
            let filesToProcess = []
            
            // Handle zip files
            if (files.length === 1 && files[0].name.endsWith('.zip')) {
                const zipFile = files[0]
                const zip = await JSZip.loadAsync(zipFile)
                
                zip.forEach((relativePath, file) => {
                    if (relativePath.endsWith('.dat') && !file.dir) {
                        filesToProcess.push({
                            name: relativePath.split('/').pop(), // Just the filename for compatibility
                            webkitRelativePath: relativePath, // Full path with folders
                            async arrayBuffer() {
                                return await file.async('arraybuffer')
                            },
                            async text() {
                                return await file.async('text')
                            }
                        })
                    }
                })
            } else if (files.length === 1 && (files[0].name.endsWith('.tar.gz') || files[0].name.endsWith('.tgz'))) {
                // Handle tar.gz files
                const tarGzFile = files[0]
                const arrayBuffer = await tarGzFile.arrayBuffer()
                filesToProcess = await ExtractTarGz(arrayBuffer)
            } else {
                // Handle individual files
                filesToProcess = Array.from(files).filter(f => f.name.endsWith('.dat'))
            }
            
            if (filesToProcess.length === 0) {
                window.alert("No .dat files found to process.")
                return
            }
            
            const { zip, processed } = await ProcessBulkFiles(
                filesToProcess, 
                this.state.bulkConvertToPC
            )
            
            if (processed.length === 0) {
                window.alert("No files could be processed.")
                return
            }
            
            const zipFileName = this.state.bulkConvertToPC ? 'converted_to_pc.zip' : 'converted_to_switch.zip'
            await DownloadZip(zip, zipFileName)
            
            window.alert(`Successfully converted ${processed.length} files: ${processed.join(', ')}`)
            
        } catch (err) {
            console.error('Bulk processing error:', err)
            window.alert("Error processing files: " + err.message)
        } finally {
            this.setState({ bulkProcessing: false })
            this.bulkFileInputRef.current.value = null
        }
    }
    render(){
        return <div id="wrapper">
            {this.state.dragging && <div id="cover"></div>}
            <p id="description">This online tool allows you to modify a Hollow Knight save file. You can also use this to convert your PC save to and from a Switch save.</p>
            <p id="source">You can view the source code in the <a href="https://github.com/bloodorca/hollow">github repo</a>.</p>
			<ul id="instructions">
                <li>Make a backup of your original file.</li>
                <li>Select or drag in the source save file you want to modify.</li>
                <li>Modify your save file. Ctrl-F / Cmd-F is your best friend.</li>
                <li>Download your new modifed save file.</li>
            </ul>
			<div>
                <button id="file-button" onClick={this.handleFileClick}>Select File</button>
                <span>
                    <input checked={this.state.switchMode} onClick={e => this.setState({switchMode: !this.state.switchMode})} type="checkbox" id="switch-save"/>
                    <label style={{color: this.state.switchMode ? "inherit" : "#777"}} htmlFor="switch-save">Nintendo Switch Mode</label>
                </span>
            </div>
            <input onChange={e => { this.handleFileChange(this.fileInputRef.current.files) }} id="file-input"  ref={this.fileInputRef} type="file"/>
            
            <div style={{marginTop: '30px', padding: '20px', border: '2px dashed #ccc', borderRadius: '8px'}}>
                <h3>Bulk Conversion (Switch/PC)</h3>
                <p>Convert multiple .dat files at once. Upload a zip file containing .dat files or select multiple .dat files.</p>
                <div style={{marginBottom: '15px'}}>
                    <button onClick={this.handleBulkFileClick} disabled={this.state.bulkProcessing}>
                        {this.state.bulkProcessing ? 'Processing...' : 'Select Files for Bulk Conversion'}
                    </button>
                </div>
                <div style={{marginBottom: '15px'}}>
                    <label>
                        <input 
                            type="radio" 
                            name="bulkConversion" 
                            checked={this.state.bulkConvertToPC} 
                            onChange={() => this.setState({bulkConvertToPC: true})}
                        />
                        Convert Switch to PC (encrypt)
                    </label>
                    <br/>
                    <label>
                        <input 
                            type="radio" 
                            name="bulkConversion" 
                            checked={!this.state.bulkConvertToPC} 
                            onChange={() => this.setState({bulkConvertToPC: false})}
                        />
                        Convert PC to Switch (decrypt)
                    </label>
                </div>
                <input 
                    onChange={e => this.handleBulkFileChange(e.target.files)} 
                    ref={this.bulkFileInputRef} 
                    type="file" 
                    multiple 
                    webkitdirectory=""
                    accept=".dat,.zip,.tar.gz,.tgz"
                    style={{display: 'none'}}
                />
            </div>
            
            {this.state.editing && (
                <div id="editor-wrapper">
                    <span id="editor-name">{this.state.gameFileName}</span>
                    <textarea id="editor" onChange={this.handleEditorChange} value={this.state.gameFile} spellCheck={false}></textarea>
                    <div id="editor-buttons">
                        <button onClick={this.handleReset}>reset</button>
                        <button onClick={this.handleDownloadAsSwitchSave}>download plain text (Switch)</button>
                        <button onClick={this.handleDownload}>download encrypted (PC)</button>
                    </div>
                </div>
            )}
            <HistoryComponent 
                handleClick={(jsonString, fileName) => this.setGameFile(jsonString, fileName)}
            />
        </div>
    }
}

class HistoryComponent extends React.Component {
    constructor(){
        super()
        history.onChange = () => {
            this.forceUpdate()
        }
    }
    render(){
        if (history.count() == 0) return null 
        return (
            <div id="history">
                <div>History</div>
                <div>Stores a limited amount of recent files. Do not use this as an alternative to making backups.</div>
                <ul>
                    {history.history.map(item => (
                        <li 
                            key={item.hash}
                            onClick={() => {
                                this.props.handleClick(item.jsonString, item.fileName)
                                window.scrollTo(0, 0)
                            }} 
                            onContextMenu={e => { 
                                history.removeFromHistory(item.hash); 
                                e.preventDefault(); 
                                history.syncToLocalStorage()
                            }} 
                            className="history-item"
                        >
                            <div className="history-name">HASH {item.hash}</div>
                            <div className="history-date">{HumanTime(item.date)}</div>
                        </li>
                    ))}
                </ul>
            </div>
        )
    }
}



ReactDOM.render(<App/>, document.querySelector("#root"))




