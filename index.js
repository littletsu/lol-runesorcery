process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import fs from 'fs';
import fetch from 'node-fetch';
import LCUConnector from 'lcu-connector';
import WebSocket from 'ws';
import cheerio from 'cheerio';

const connector = new LCUConnector();
const pageFile = 'page.txt';
const leagueofgraphs = 'www.leagueofgraphs.com'
let pageId;
console.log("Connecting to LCU")

const getPageTxt = () => {
    try {
        return parseInt(fs.readFileSync(pageFile, 'utf8'));
    } catch {
        return null;
    }
}
const setPageId = (newPage) => {
    pageId = newPage;
    return fs.writeFileSync(pageFile, newPage.toString());
}
const getStyleIdFromUrl = url => parseInt(url.split('/').slice(-1)[0].slice(0, -4))
const getPerkIdFromClassName = className => parseInt(className.split(' ')[0].split('-')[1])
const getPerksIdFromElements = ($, selector, slice) => Array.from($(selector).slice(0, slice).map((_, el) => getPerkIdFromClassName(el.attribs.class))) 
const asyncTimeout = timeout => {
    return new Promise((res) => {
        setTimeout(() => res(), timeout);
    })
} 
const isEmpty = (arr) => arr.length === 0;
const onLCUConnect = async (data) => {
    const { username, password, address, port } = data;
    const url = `${address}:${port}`;
    const wsUrl = `wss://${username}:${password}@${address}:${port}`;

    console.log(`Connected to ${username}:${password} | ${url}`)
    const request = async (path, requestURL, text=false, method='GET', body, headers={}, currentAttempts=0, retryTimeout=5000, maxAttempts=5) => {
        let defaultHeaders = requestURL ? {} : {
            'Authorization': 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')
        };
        if(body) defaultHeaders['content-type'] = 'application/json';
        let req;
        const fetchURL = `https://${requestURL || url}/${path}`;
        try {
            req = await fetch(fetchURL, {
                method: method,
                headers: Object.assign(defaultHeaders, headers),
                body: (typeof body === "object") && (body) ? JSON.stringify(body) : body
            });
        } 
        catch (err) {
            if(err.code === 'ECONNREFUSED' && currentAttempts <= maxAttempts) {
                console.log(`Request to ${fetchURL} got connection refused, trying again in ${retryTimeout}ms. (${currentAttempts}/${maxAttempts})`);
                await asyncTimeout(retryTimeout);
                return request(path, requestURL, text, method, body, headers, currentAttempts+1, retryTimeout, maxAttempts)
            }
        }
        
        
        if(text) {
            const text = await req.text();
            return text;
        }
        const json = await req.json();
        return json;
    }
    
    let perks;
    const getLolPerksStyles = async (currentAttempts=0, retryTimeout=5000, maxAttempts=5) => {
        perks = await request('lol-perks/v1/perks');
        
        if(isEmpty(perks) && currentAttempts <= maxAttempts) {
            console.log(`Lol Perks or styles empty, retrying again in ${retryTimeout}ms... (${currentAttempts}/${maxAttempts})`);
            await asyncTimeout(retryTimeout);
            return getLolPerksStyles(currentAttempts+1, retryTimeout, maxAttempts);
        }
    }
    const styles = await request('lol-perks/v1/styles');
    await getLolPerksStyles();

    const summoner = await request('lol-summoner/v1/current-summoner');
    let pages = await request('lol-perks/v1/pages');
    const findNameOr = (arr, id) => arr.find(obj => obj.id === id)?.name || id
    const findStyleName = id => findNameOr(styles, id);
    const findPerkName = id => findNameOr(perks, id);
    console.log("!", findStyleName(8200), findPerkName(8345))
    /*console.log(pages.map(page => 
        `${page.name} (${findNameOr(styles, page.primaryStyleId)}, ${findNameOr(styles, page.subStyleId)})\n\t${page.selectedPerkIds.map(perkId => findNameOr(perks, perkId)).join('\n\t')}`
    ).join('\n'))*/
    setPageId(getPageTxt() || pages.find(page => (page.name.startsWith("awa: ")) || (!page.isValid)).id);
    console.log(`Current page is:`, pages.find(page => page.id === pageId))

    const ws = new WebSocket(wsUrl);
    ws.on('open', () => {
        console.log(`LCU Websocket open ${wsUrl}`);
        ws.send(JSON.stringify([5, "OnJsonApiEvent"]));
    })

    // todo: make args an object
    const modifyPage = async (runepageId, primaryStyleId, selectedPerkIds, subStyleId, name) => {
        await request(`lol-perks/v1/pages/${runepageId}`, null, true, 'DELETE')
        
        const response = await request(`lol-perks/v1/pages`, null, false, 'POST', {
            primaryStyleId,
            selectedPerkIds,
            subStyleId,
            name,
            current: true
        })
        
        setPageId(response.id);
        //await request(`lol-perks/v1/currentpage`, null, true, 'PUT', runepageId)
        
        return response;
    }

    const currentChampion = await request('lol-champ-select/v1/current-champion');
    const fetchChampionRunes = async (championId) => {
        const champion = await request(`lol-champions/v1/inventories/${summoner.summonerId}/champions/${championId}`);
        console.log(`Making runes for ${champion.alias}`)
        const championRunesHTML = await request(`champions/runes/${champion.alias.toLowerCase()}`, leagueofgraphs, true)
        //console.log(championRunesHTML)
        const $ = cheerio.load(championRunesHTML);
        const selectedPage = 0;
        const styleImgs = $(".perksTableContainerTable")[selectedPage].children[1].children[0].children[1].children
        const primaryStyleId = getStyleIdFromUrl(styleImgs[1].attribs.src);
        const subStyleId = getStyleIdFromUrl(styleImgs[3].attribs.src);
        
        const primaryPerksId = getPerksIdFromElements($, `img[style="opacity: 1; "]`, 4)
        const secondaryPerksId = getPerksIdFromElements($, `img[style="opacity: 0.6; opacity:1"]`, 2)
        const statPerksId = getPerksIdFromElements($, 'div.img-align-block > div[style=""] > img', 3)
        
        console.log(
            findStyleName(primaryStyleId) + '\n' +
            '\t' + primaryPerksId.map(findPerkName).join('\n\t') + '\n' +
            findStyleName(subStyleId) + '\n' +
            '\t' + secondaryPerksId.map(findPerkName).join('\n\t') + '\n' +
            statPerksId.map(findPerkName).join('\n') + '\n'
        )
        
        const selectedPerkIds = [...primaryPerksId, ...secondaryPerksId, ...statPerksId];
        await modifyPage(pageId, primaryStyleId, selectedPerkIds, subStyleId, champion.name);
    }

    if(currentChampion?.httpStatus !== 404) {
        fetchChampionRunes(currentChampion);
    }

    ws.on('message', async (msg) => {
        if(msg.length === 0) return;
        const message = JSON.parse(msg.toString());
        const event = message[2];
        const { data, uri, eventType } = event;
        
        if(uri.endsWith('champ-select/v1/current-champion') && (eventType === 'Create' || eventType === 'Update')) {
            fetchChampionRunes(data);
        }
        
    })
}

connector.on('connect', onLCUConnect);

connector.on('disconnect', () => {
    console.log('LCU Disconnect, waiting for reconnection.')
    connector.start();
})

connector.start();