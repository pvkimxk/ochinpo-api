import bytes from 'bytes'
import cp from 'child_process'
import express from 'express'
import favicon from 'serve-favicon'
import fs from 'fs'
import morgan from 'morgan'
import os from 'os'
import path from 'path'
import playwright from 'playwright'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import util from 'util'
import yts from 'yt-search'

const utils = {
	getBrowser: (...opts) =>
		playwright.chromium.launch({
			args: [
				'--incognito',
				'--single-process',
				'--no-sandbox',
				'--no-zygote',
				'--no-cache'
			],
			executablePath: process.env.CHROME_BIN,
			headless: true,
			...opts
		}),
	// from https://github.com/petersolopov/carbonara
	fetchCarbonaraAPI: async (code, opts = {}) => {
		let resp = await utils.fetchPOST(
			'https://carbonara.solopov.dev/api/cook',
			JSON.stringify({ code, ...opts }),
			{
				headers: { 'Content-Type': 'application/json' }
			}
		)
		if (!resp.ok) {
			let content = resp.headers.get('content-type')
			if (/json$/.test(content)) {
				let json = await resp.json()
				throw json.error || 'An error occurred'
			}
			throw resp.statusText
		}

		let img = await resp.arrayBuffer()
		const output = `${tmpDir}/${utils.randomName('.png')}`
		await fs.promises.writeFile(output, Buffer.from(img))
		return output
	},
	/*
	fetchCobaltAPI: async (url, opts = {}) =>
		(
			await utils.fetchPOST(
				'https://capi.3kh0.net',
				JSON.stringify({ url, ...opts }),
				{
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/json'
					}
				}
			)
		).json(),
	*/
	fetchMediafireAPI: async (id) => {
		// TODO: folder download
		let resp = await fetch(
			`https://mediafire.com/api/1.5/file/get_info.php?response_format=json&quick_key=${id}`
		)
		let json = await resp.json()
		return json.response
	},
	fetchPOST: (url, body, opts = {}) =>
		fetch(url, { method: 'POST', body, ...opts }),
	fetchSaveTubeAPI: async (opts = {}) => {
		const headers = {
			Authority: 'cdn59.savetube.su',
			'Content-Type': 'application/json'
		}

		const makeRequest = async (endpoint) =>
			(
				await utils.fetchPOST(
					`https://${headers.Authority}${endpoint}`,
					JSON.stringify(opts),
					{ headers }
				)
			).json()

		let info = await makeRequest('/info')
		opts.key = info.data.key
		return makeRequest('/download')
	},
	formatSize: (n) => bytes(+n, { unitSeparator: ' ' }),
	generateBrat: async (text) => {
		const browser = await utils.getBrowser()
		try {
			const page = await browser.newPage()
			await page.goto('https://www.bratgenerator.com/')
			await page.click('#toggleButtonWhite')
			await page.locator('#textInput').fill(text)
			const output = `${tmpDir}/${utils.randomName('.jpg')}`
			const ss = await page.locator('#textOverlay').screenshot({ path: output })
			return output
		} catch (e) {
			throw e
		} finally {
			if (browser) await browser.close()
		}
	},
	getMediafireDownloadLink: async (url) => {
		let resp = await fetch(url)
		let html = await resp.text()
		let dl = html.match(/href="(.*?)".*id="downloadButton"/)?.[1]
		return dl
			? {
					cookie: resp.headers.get('set-cookie'),
					download: dl
				}
			: false
	},
	getError: (e) =>
		String(e).startsWith('[object ') ? 'Internal Server Error' : String(e),
	isBase64: (str) => {
		try {
			return btoa(atob(str)) === str
		} catch {
			return false
		}
	},
	isTrue: (str) => [true, 'true'].includes(str),
	mediafireIdRegex: /https?:\/\/(www.)?mediafire.com\/(file|folder)\/(\w+)/,
	randomIP: () =>
		[...new Array(4)].map(() => ~~(Math.random() * 256)).join('.'),
	randomName: (str = '') => Math.random().toString(36).slice(2) + str,
	toPDF: (urls, opts = {}) =>
		new Promise(async (resolve, reject) => {
			try {
				const doc = new PDFDocument({ margin: 0, size: 'A4' })
				const buffs = []

				for (let x = 0; x < urls.length; x++) {
					if (!/https?:\/\//.test(urls[x])) continue
					const url = new URL(urls[x])
					let image = await fetch(url.toString(), {
						headers: { referer: url.origin }
					})
					if (!image.ok) continue

					const type = image.headers.get('content-type')
					if (!/image/.test(type)) continue
					image = Buffer.from(await image.arrayBuffer())
					if (/(gif|webp)$/.test(type))
						image = await sharp(image).png().toBuffer()

					doc.image(image, 0, 0, {
						fit: [595.28, 841.89],
						align: 'center',
						valign: 'center',
						...opts
					})
					if (urls.length != x + 1) doc.addPage()
				}

				doc.on('data', (chunk) => buffs.push(chunk))
				doc.on('end', () => resolve(Buffer.concat(buffs)))
				doc.on('error', (err) => reject(err))
				doc.end()
			} catch (e) {
				console.log(e)
				reject(e)
			}
		}),
	// from https://github.com/Nurutomo/wabot-aq/blob/master/lib/y2mate.js#L15
	ytIdRegex:
		/(?:http(?:s|):\/\/|)(?:(?:www\.|)?youtube(?:\-nocookie|)\.com\/(?:shorts\/)?(?:watch\?.*(?:|\&)v=|embed\/|live\/|v\/)?|youtu\.be\/)([-_0-9A-Za-z]{11})/
}

const app = express()
const tmpDir = os.tmpdir()

app.set('json spaces', 4)
app.use(express.json({ limit: '200mb' }))
app.use(express.urlencoded({ extended: true, limit: '200mb' }))
app.use(favicon(path.join(import.meta.dirname, 'favicon.ico')))
app.use(morgan('combined'))

app.use((req, __, next) => {
	// clear tmp
	/*
	for (let file of fs.readdirSync(tmpDir)) {
		file = `${tmpDir}/${file}`
		const stat = fs.statSync(file)
		const exp = Date.now() - stat.mtimeMs >= 1000 * 60 * 30
		if (stat.isFile() && exp) {
			console.log('Deleting file', file)
			fs.unlinkSync(file)
		}
	}
	*/
	req.allParams = Object.assign(req.query, req.body)
	next()
})

app.use('/file', express.static(tmpDir))

app.all('/', (_, res) => {
	const status = {}
	status['diskUsage'] = cp.execSync('du -sh').toString().split('M')[0] + ' MB'

	const used = process.memoryUsage()
	for (let x in used) status[x] = utils.formatSize(used[x])

	const totalmem = os.totalmem()
	const freemem = os.freemem()
	status['memoryUsage'] =
		`${utils.formatSize(totalmem - freemem)} / ${utils.formatSize(totalmem)}`

	const id = process.env.SPACE_ID
	res.json({
		message: id
			? `Go to https://github.com/orgs/pvkimxk/discussions for discuss`
			: 'Hello World!',
		uptime: new Date(process.uptime() * 1000).toUTCString().split(' ')[4],
		status
	})
})

app.all(/^\/(brat|carbon)/, async (req, res) => {
	if (!['GET', 'POST'].includes(req.method))
		return res
			.status(405)
			.json({ success: false, message: 'Method Not Allowed' })

	try {
		const obj = req.allParams
		const isBrat = req.params[0] === 'brat'
		if (isBrat && !obj.text) {
			return res
				.status(400)
				.json({ success: false, message: "Required parameter 'text'" })
		} else if (!isBrat && !(obj.code || obj.text)) {
			return res
				.status(400)
				.json({ success: false, message: "Required parameter 'code'" })
		}

		const image = isBrat
			? await utils.generateBrat(obj.text)
			: await utils.fetchCarbonaraAPI(obj.code || obj.text, obj)
		const resultUrl = `https://${req.hostname}/${image.replace(tmpDir, 'file')}`
		utils.isTrue(obj.json)
			? res.json({ success: true, result: resultUrl })
			: res[utils.isTrue(obj.raw) ? 'send' : 'redirect'](resultUrl)
	} catch (e) {
		console.log(e)
		res.status(500).json({ error: true, message: utils.getError(e) })
	}
})

app.all('/mediafire', async (req, res) => {
	if (!['GET', 'POST'].includes(req.method))
		return res
			.status(405)
			.json({ success: false, message: 'Method Not Allowed' })

	try {
		const obj = req.allParams
		if (!obj.url)
			return res
				.status(400)
				.json({ success: false, message: "Required parameter 'url'" })
		if (!utils.mediafireIdRegex.test(obj.url))
			return res.status(400).json({ success: false, message: 'Invalid url' })

		const [, _, type, id] = utils.mediafireIdRegex.exec(obj.url)
		if (type === 'folder')
			return res
				.status(400)
				.json({ success: false, message: 'Folder download not supported yet' })
		if (!id)
			return res
				.status(400)
				.json({ success: false, message: 'Cannot find file id' })

		const [data, result] = await Promise.all([
			utils.fetchMediafireAPI(id),
			utils.getMediafireDownloadLink(obj.url)
		])
		if (data.error)
			return res.status(400).json({ success: false, message: data.message })

		for (let [key, val] of Object.entries(data.file_info)) {
			if (key === 'links') continue
			if (key === 'size') val = utils.formatSize(val)
			key = key.split('_')[0]
			result[key] = val
		}

		res.json({ success: true, result })
	} catch (e) {
		console.log(e)
		res.status(500).json({ error: true, message: utils.getError(e) })
	}
})

app.all('/topdf', async (req, res) => {
	if (req.method !== 'POST')
		return res
			.status(405)
			.json({ success: false, message: 'Method Not Allowed' })

	try {
		const { images: urls, json, raw } = req.body
		if (!urls)
			return res.status(400).json({
				success: false,
				message: "Payload 'images' requires an array of urls"
			})
		if (!Array.isArray(urls)) urls = [urls]

		const bufferPDF = await utils.toPDF(urls)
		if (!bufferPDF.length)
			return res
				.status(400)
				.json({ success: false, message: "Can't convert to pdf" })

		const fileName = utils.randomName('.pdf')
		await fs.promises.writeFile(`${tmpDir}/${fileName}`, bufferPDF)

		const resultUrl = `https://${req.hostname}/file/${fileName}`
		utils.isTrue(json)
			? res.json({ success: true, result: resultUrl })
			: res[utils.isTrue(raw) ? 'send' : 'redirect'](resultUrl)
	} catch (e) {
		console.log(e)
		res.status(500).json({ error: true, message: utils.getError(e) })
	}
})

app.all(/^\/webp2(gif|mp4|png)/, async (req, res) => {
	if (req.method !== 'POST')
		return res
			.status(405)
			.json({ success: false, message: 'Method Not Allowed' })

	try {
		const { file, json, raw } = req.body
		if (!file)
			return res.status(400).json({
				success: false,
				message: "Payload 'file' requires base64 string"
			})
		if (!utils.isBase64(file))
			return res
				.status(400)
				.json({ success: false, message: 'Invalid base64 format' })

		const type = req.params[0]
		if (type === 'png') {
			const fileName = utils.randomName('.png')
			const fileBuffer = await sharp(Buffer.from(file, 'base64'))
				.png()
				.toBuffer()
			await fs.promises.writeFile(`${tmpDir}/${fileName}`, fileBuffer)

			const resultUrl = `https://${req.hostname}/file/${fileName}`
			utils.isTrue(json)
				? res.json({ success: true, result: resultUrl })
				: res[utils.isTrue(raw) ? 'send' : 'redirect'](resultUrl)
			return
		}

		const fileName = utils.randomName('.webp')
		const filePath = `${tmpDir}/${fileName}`
		await fs.promises.writeFile(filePath, Buffer.from(file, 'base64'))

		const exec = util.promisify(cp.exec).bind(cp)
		await exec(`convert ${filePath} ${filePath.replace('webp', 'gif')}`)

		let resultUrl
		if (type === 'gif')
			resultUrl = `https://${req.hostname}/file/${fileName.replace('webp', 'gif')}`
		else {
			await exec(
				`ffmpeg -i ${filePath.replace('webp', 'gif')} -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" ${filePath.replace('webp', 'mp4')}`
			)
			resultUrl = `https://${req.hostname}/file/${fileName.replace('webp', 'mp4')}`
		}

		utils.isTrue(json)
			? res.json({ success: true, result: resultUrl })
			: res[utils.isTrue(raw) ? 'send' : 'redirect'](resultUrl)
	} catch (e) {
		console.log(e)
		res.status(500).json({ error: true, message: utils.getError(e) })
	}
})

// /yt /yt/dl /yt/download /yt/search /youtube/dl /youtube/download /youtube/search
app.all(/^\/y(outube|t)(\/(d(ownload|l)|search)?)?/, async (req, res) => {
	if (!['GET', 'POST'].includes(req.method))
		return res
			.status(405)
			.json({ success: false, message: 'Method Not Allowed' })

	try {
		const type = req.params[2]
		const obj = req.allParams
		if (type === 'search') {
			if (!obj.query)
				return res
					.status(400)
					.json({ success: false, message: "Required parameter 'query'" })

			const result = await yts(obj)
			if (!(result.all?.length || result?.url))
				return res
					.status(400)
					.json({ success: false, message: 'Video unavailable' })

			res.json({ success: true, result })
			return
		} else if (['dl', 'download'].includes(type)) {
			if (!obj.url)
				return res
					.status(400)
					.json({ success: false, message: "Required parameter 'url'" })
			if (!utils.ytIdRegex.test(obj.url))
				return res.status(400).json({ success: false, message: 'Invalid url' })

			const isAudio = obj.type !== 'video'
			const payload = {
				downloadType: isAudio ? 'audio' : 'video',
				quality: obj.quality ? String(obj.quality) : isAudio ? '128' : '720',
				url: obj.url
			}
			console.log(payload)

			const result = await utils.fetchSaveTubeAPI(payload)
			if (!result.data?.downloadUrl) {
				console.log(result)
				return res
					.status(400)
					.json({ success: false, message: 'An error occurred' })
            }

			res.redirect(result.data.downloadUrl)
			return
		}

		if (!obj.query)
			return res
				.status(400)
				.json({ success: false, message: "Required parameter 'query'" })

		let result = await yts(
			utils.ytIdRegex.test(obj.query)
				? { videoId: utils.ytIdRegex.exec(obj.query)[1] }
				: obj.query
		)
		result = result.videos ? result.videos[0] : result
		if (!result?.url)
			return res
				.status(400)
				.json({ success: false, message: 'Video unavailable' })

		const dlUrl = `https://${req.hostname}/yt/dl?url=${result.url}`
		const download = {
			audio: `${dlUrl}&type=audio`,
			video: `${dlUrl}&type=video`
		}
		res.json({
			success: true,
			result: { ...result, download }
		})
	} catch (e) {
		console.log(e)
		res.status(500).json({ error: true, message: utils.getError(e) })
	}
})

// app.use((req, res, next) => {})

const PORT = process.env.PORT || 7860
app.listen(PORT, () => console.log(`App running on port ${PORT}`))
