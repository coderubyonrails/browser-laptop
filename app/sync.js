/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict'

const Immutable = require('immutable')
const electron = require('electron')
const qr = require('qr-image')
const ipcMain = electron.ipcMain
const locale = require('./locale')
const messages = require('../js/constants/messages')
const syncMessages = require('../js/constants/sync/messages')
const categories = require('../js/constants/sync/proto').categories
const writeActions = require('../js/constants/sync/proto').actions
const config = require('../js/constants/appConfig').sync
const syncExtensionId = require('../js/constants/config').syncExtensionId
const appActions = require('../js/actions/appActions')
const syncConstants = require('../js/constants/syncConstants')
const appDispatcher = require('../js/dispatcher/appDispatcher')
const AppStore = require('../js/stores/appStore')
const syncUtil = require('../js/state/syncUtil')
const syncPendState = require('./common/state/syncPendState')
const getSetting = require('../js/settings').getSetting
const settings = require('../js/constants/settings')
const extensions = require('./extensions')
const {unescapeJSONPointer} = require('./common/lib/jsonUtil')
const bookmarkFoldersUtil = require('./common/lib/bookmarkFoldersUtil')
const bookmarkFoldersState = require('./common/state/bookmarkFoldersState')
const bookmarksState = require('./common/state/bookmarksState')
const {STATE_SITES} = require('../js/constants/stateConstants')

const CATEGORY_MAP = syncUtil.CATEGORY_MAP
const CATEGORY_NAMES = Object.keys(categories)
const SYNC_ACTIONS = Object.values(syncConstants)
const STATE_SITES_VALUES = Object.values(STATE_SITES)

// Fields that should trigger a sync SEND when changed
const SYNC_FIELDS_SITES = ['location', 'title', 'folderId', 'parentFolderId', 'tags']
const SYNC_FIELDS = {
  [STATE_SITES.BOOKMARKS]: SYNC_FIELDS_SITES,
  [STATE_SITES.BOOKMARK_FOLDERS]: SYNC_FIELDS_SITES,
  [STATE_SITES.HISTORY_SITES]: SYNC_FIELDS_SITES,
  siteSettings: Object.keys(syncUtil.siteSettingDefaults)
}

// The sync background script message sender
let backgroundSender = null

const log = (message) => {
  if (!config.debug) { return }
  console.log(`sync ${new Date().getTime()}:`, message)
}

let deviceId = null /** @type {Array|null} */
let pollIntervalId = null

let deviceIdSent = false
let bookmarksToolbarShown = false

// Determines what to sync
const appStoreChangeCallback = function (diffs) {
  if (!backgroundSender || !diffs) {
    return
  }

  diffs.forEach((diff) => {
    if (!diff || !diff.path) {
      return
    }
    const path = diff.path.split('/')
    if (path.length < 3) {
      // We are looking for paths like ['', 'bookmarks', 'https://brave.com/', 'title']
      return
    }

    const type = path[1]
    const field = path[3]
    const isSite = STATE_SITES_VALUES.includes(type)

    const fieldsToPick = SYNC_FIELDS[type]
    if (!fieldsToPick) {
      return
    }

    const statePath = path.slice(1, 3).map(unescapeJSONPointer)
    if (field === 'skipSync' && diff.value === true) {
      // Remove the flag so that this gets synced next time it is updated
      appActions.setSkipSync(statePath, false)
      return
    }

    const isInsert = diff.op === 'add' && path.length === 3
    const isUpdate = fieldsToPick.includes(field) // Ignore insignicant updates

    // DELETES are handled in appState because the old object is no longer
    // available by the time emitChanges is received
    if (isInsert || isUpdate) {
      // Get the item's path and entry in appStore
      const entry = AppStore.getState().getIn(statePath)
      if (!entry || !entry.toJS) {
        return
      }
      if (entry.get('skipSync')) {
        // Remove the flag so that this gets synced next time it is updated
        appActions.setSkipSync(statePath, false)
        return
      }

      let action = null

      if (isInsert) {
        // Send UPDATE instead of CREATE for sites to work around sync#111
        action = isSite ? writeActions.UPDATE : writeActions.CREATE
      } else if (isUpdate) {
        action = writeActions.UPDATE
      }

      if (action !== null) {
        // Set the object ID if there is not already one
        const entryJS = entry.toJS()
        entryJS.objectId = entryJS.objectId || syncUtil.newObjectId(statePath)

        let record = null
        if (type === STATE_SITES.BOOKMARKS || type === STATE_SITES.BOOKMARK_FOLDERS) {
          record = syncUtil.createBookmarkData(entryJS)
        } else if (type === STATE_SITES.HISTORY_SITES) {
          record = syncUtil.createHistorySiteData(entryJS)
        } else {
          record = syncUtil.createSiteSettingsData(statePath[1], entryJS)
        }
        sendSyncRecords(backgroundSender, action, [record])
      }
    }
  })
}

/**
 * Sends sync records of the same category to the sync server.
 * @param {event.sender} sender
 * @param {number} action
 * @param {Array.<{name: string, value: Object}>} data
 * @returns {Array.<object>} records which were sent
 */
const sendSyncRecords = (sender, action, data) => {
  if (!deviceId) {
    throw new Error('Cannot build a sync record because deviceId is not set')
  }
  if (!data || !data.length || !data[0]) {
    return []
  }
  const category = CATEGORY_MAP[data[0].name]
  if (!category ||
    (category.settingName && !getSetting(settings[category.settingName]))) {
    return []
  }
  const records = []
  data.forEach(item => {
    if (!item || !item.name || !item.value || !item.objectId) {
      return
    }
    records.push({
      action,
      deviceId,
      objectId: item.objectId,
      [item.name]: item.value
    })
  })
  log(`Sending ${records.length} sync records`)
  sender.send(syncMessages.SEND_SYNC_RECORDS, category.categoryName, records)
  appActions.pendingSyncRecordsAdded(records)
  return records
}

/**
 * @param {Object} action
 * @returns {boolean}
 */
const validateAction = (action) => {
  const SYNC_ACTIONS_WITHOUT_ITEMS = [
    syncConstants.SYNC_CLEAR_HISTORY,
    syncConstants.SYNC_CLEAR_SITE_SETTINGS
  ]
  if (SYNC_ACTIONS.includes(action.actionType) !== true) {
    return false
  }

  // If the action requires items, validate the items.
  if (SYNC_ACTIONS_WITHOUT_ITEMS.includes(action.actionType) !== true) {
    if (!action.items || !action.items.length) {
      log('Missing items!')
      return false
    }
  }
  return true
}

const dispatcherCallback = (action) => {
  if (!backgroundSender) {
    return
  }

  if (action.key === settings.SYNC_ENABLED) {
    if (action.value === false) {
      module.exports.stop()
    }
  }
  // If sync is not enabled, the following actions should be ignored.
  if (!syncUtil.syncEnabled() || validateAction(action) !== true || backgroundSender.isDestroyed()) {
    return
  }
  switch (action.actionType) {
    // NOTE: Most sites are actually added via the AppStore change listener.
    // The bookmarks importer uses this because the it creates jumbled site
    // diffs.
    case syncConstants.SYNC_ADD_SITES:
      sendSyncRecords(backgroundSender, writeActions.CREATE,
        action.items.map(item => syncUtil.createBookmarkData(item)))
      break
    // Currently triggered only by bookmarksState and bookmarkFoldersState.
    case syncConstants.SYNC_REMOVE_SITES:
      // Only accept items who have an objectId set already
      const validItems = action.items.filter(item => {
        if (item.objectId) {
          return true
        }
        log(`Missing object ID! ${JSON.stringify(item)}`)
        return false
      })
      sendSyncRecords(backgroundSender, writeActions.DELETE,
        validItems.map(item => syncUtil.createBookmarkData(item)))
      break
    case syncConstants.SYNC_CLEAR_HISTORY:
      backgroundSender.send(syncMessages.DELETE_SYNC_CATEGORY, CATEGORY_MAP.historySite.categoryName)
      break
    case syncConstants.SYNC_CLEAR_SITE_SETTINGS:
      backgroundSender.send(syncMessages.DELETE_SYNC_SITE_SETTINGS)
      break
    default:
  }
}

/**
 * Called when sync client is done initializing.
 * @param {boolean} isFirstRun - whether this is the first time sync is running
 * @param {Event} e
 */
module.exports.onSyncReady = (isFirstRun, e) => {
  appActions.setSyncSetupError(null)
  if (!syncUtil.syncEnabled()) {
    return
  }
  AppStore.addChangeListener(appStoreChangeCallback)
  const appState = AppStore.getState()

  // poll() calls this periodically.
  const resendPendingRecords = () => {
    const state = AppStore.getState()
    const timeSinceLastConfirm = new Date().getTime() - state.getIn(['sync', 'lastConfirmedRecordTimestamp'])
    if (timeSinceLastConfirm < config.resendPendingRecordInterval) {
      return
    }
    // Sync records which haven't been confirmed yet.
    const pendingRecords = syncPendState.getPendingRecords(state)
    if (pendingRecords.length === 0) {
      return
    }
    log(`Resending ${pendingRecords.length} pending records`)
    e.sender.send(syncMessages.SEND_SYNC_RECORDS, undefined, pendingRecords)
  }

  if (!deviceIdSent && isFirstRun) {
    // Sync the device id for this device
    const deviceRecord = {
      name: 'device',
      objectId: syncUtil.newObjectId(['sync']),
      value: {
        name: getSetting(settings.SYNC_DEVICE_NAME)
      }
    }
    sendSyncRecords(e.sender, writeActions.CREATE, [deviceRecord])
    deviceIdSent = true
  }
  const seed = appState.get('seed') || new Immutable.List()

  /**
   * Sync a bookmark that has not been synced yet, first syncing the parent
   * folder if needed. For folders, set and memoize folderId to ensure
   * consistent parentFolderObjectIds.
   * Otherwise syncUtil.createBookmarkData() will generate new objectIds every
   * call; there's not enough time to dispatch id updates to appStore.sites.
   * @param {Immutable.Map} site
   */
  const folderToObjectId = {}
  const bookmarksToSync = []

  const shouldSyncBookmark = (bookmark) => {
    // originalSeed is set on reset to prevent synced bookmarks on a device
    // from being  re-synced.
    const originalSeed = bookmark.get('originalSeed')
    if (bookmark.get('objectId') && (!originalSeed || seed.equals(originalSeed))) {
      return false
    }

    // If this this exists, then we must have synced it; see below:
    return !folderToObjectId[bookmark.get('folderId')]
  }

  const syncBookmark = (bookmark, appState) => {
    const bookmarkJS = bookmark.toJS()

    const parentFolderId = bookmark.get('parentFolderId')
    if (typeof parentFolderId === 'number') {
      if (!folderToObjectId[parentFolderId]) {
        const folderResult = bookmarkFoldersState.getFolder(appState, parentFolderId)
        if (!folderResult.isEmpty()) {
          syncBookmark(folderResult, appState)
        }
      }
      bookmarkJS.parentFolderObjectId = folderToObjectId[parentFolderId]
    }

    const record = syncUtil.createBookmarkData(bookmarkJS, appState)
    const folderId = bookmark.get('folderId')
    if (typeof folderId === 'number') {
      folderToObjectId[folderId] = record.objectId
    }

    bookmarksToSync.push(record)
  }

  // Sync bookmarks that have not been synced yet.
  const syncBookmarkFolder = (parentFolderId, appState) => {
    const bookmarks = bookmarksState.getBookmarksWithFolders(appState, parentFolderId)
    bookmarks.forEach((bookmark) => {
      if (shouldSyncBookmark(bookmark) === true) {
        syncBookmark(bookmark, appState)
      }
      if (bookmarkFoldersUtil.isFolder(bookmark)) {
        syncBookmarkFolder(bookmark.get('folderId'), appState)
      }
    })
  }
  // Sync bookmarks starting from the top level.
  syncBookmarkFolder(0, appState)
  // Other bookmarks
  syncBookmarkFolder(-1, appState)
  sendSyncRecords(e.sender, writeActions.CREATE, bookmarksToSync)

  // Sync site settings that have not been synced yet
  // FIXME: If Sync was disabled and settings were changed, those changes
  // might not be synced.
  const siteSettings =
    appState.get('siteSettings').filter((value, key) => {
      return !value.get('objectId') && syncUtil.isSyncableSiteSetting(value)
    }).toJS()
  if (siteSettings) {
    const siteSettingsData = Object.keys(siteSettings).map((item) => {
      return syncUtil.createSiteSettingsData(item, siteSettings[item])
    })
    sendSyncRecords(e.sender, writeActions.UPDATE, siteSettingsData)
  }

  appActions.createSyncCache()
  e.sender.send(syncMessages.FETCH_SYNC_DEVICES)

  // Periodically poll for new records
  let startAt = appState.getIn(['sync', 'lastFetchTimestamp']) || 0
  const poll = () => {
    let categoryNames = []
    for (let type in CATEGORY_MAP) {
      let item = CATEGORY_MAP[type]
      if (item.settingName && getSetting(settings[item.settingName]) === true) {
        categoryNames.push(item.categoryName)
      }
    }
    e.sender.send(syncMessages.FETCH_SYNC_RECORDS, categoryNames, startAt)
    // Reduce syncUtil.now() by this amount to compensate for records pending S3 consistency. See brave/sync #139
    startAt = syncUtil.now() - config.fetchOffset
    appActions.saveSyncInitData(null, null, startAt)
    resendPendingRecords()
  }
  poll()
  pollIntervalId = setInterval(poll, config.fetchInterval)
}

/**
 * Called to initialize sync, regardless of whether it is enabled.
 * @param {Object} initialState - initial appState.sync
 */
module.exports.init = function (appState) {
  const initialState = appState.get('sync') || new Immutable.Map()
  const reset = () => {
    log('Resetting browser local sync state.')
    appActions.changeSetting(settings.SYNC_ENABLED, false)
    appActions.changeSetting(settings.SYNC_DEVICE_NAME, undefined)
    appActions.resetSyncData()
  }
  // sent by about:preferences when sync should be reloaded
  ipcMain.on(messages.RELOAD_SYNC_EXTENSION, () => {
    console.log('reloading sync')
    extensions.reloadExtension(syncExtensionId)
  })
  // sent by about:preferences when resetting sync
  ipcMain.on(messages.RESET_SYNC, (e) => {
    if (backgroundSender) {
      // send DELETE_SYNC_USER to sync client. it replies with DELETED_SYNC_USER
      backgroundSender.send(syncMessages.DELETE_SYNC_USER)
    } else {
      reset()
    }
  })
  ipcMain.on(syncMessages.DELETED_SYNC_USER, (e) => {
    reset()
  })
  // GET_INIT_DATA is the first message sent by the sync-client when it starts
  ipcMain.on(syncMessages.GET_INIT_DATA, (e, syncVersion) => {
    if (syncVersion) {
      appActions.setVersionInfo('Brave Sync', syncVersion)
    }
    // Set the message sender
    backgroundSender = e.sender
    // Clear any old errors
    appActions.setSyncSetupError(null)
    // Unregister the previous dispatcher cb
    if (dispatcherCallback) {
      appDispatcher.unregister(dispatcherCallback)
    }
    // Register the dispatcher callback now that we have a valid sender
    appDispatcher.register(dispatcherCallback)
    // Send the initial data
    if (syncUtil.syncEnabled()) {
      const appState = AppStore.getState().get('sync')
      const seed = appState.get('seed') ? Array.from(appState.get('seed')) : null
      deviceId = appState.get('deviceId') ? Array.from(appState.get('deviceId')) : null
      const syncConfig = {
        apiVersion: config.apiVersion,
        debug: config.debug,
        serverUrl: getSetting(settings.SYNC_NETWORK_DISABLED)
          ? 'http://localhost' // set during tests to simulate network failure
          : config.serverUrl
      }
      e.sender.send(syncMessages.GOT_INIT_DATA, seed, deviceId, syncConfig)
    }
  })
  // SAVE_INIT_DATA is sent by about:preferences before sync is enabled
  // when restoring from an existing seed
  ipcMain.on(syncMessages.SAVE_INIT_DATA, (e, seed, newDeviceId) => {
    const isRestoring = seed && !newDeviceId
    if (!deviceId && newDeviceId) {
      deviceId = Array.from(newDeviceId)
    }
    if (!seed && newDeviceId) {
      appActions.saveSyncInitData(null, new Immutable.List(newDeviceId), null)
      return
    }
    try {
      let chunks = []
      qr.image(Buffer.from(seed).toString('hex')).on('data', (chunk) => {
        chunks.push(chunk)
      }).on('end', () => {
        let seedQr = 'data:image/png;base64,' + Buffer.concat(chunks).toString('base64')
        appActions.saveSyncInitData(new Immutable.List(seed),
          newDeviceId ? new Immutable.List(newDeviceId) : null, null, seedQr)
      })
    } catch (ex) {
      console.log('qr image error: ' + ex.toString())
      appActions.saveSyncInitData(new Immutable.List(seed),
        newDeviceId ? new Immutable.List(newDeviceId) : null)
    }
    if (isRestoring) {
      // we are restoring from a previous seed. wait for the seed to be saved
      // before reloading, or sync-client will override the seed.
      extensions.reloadExtension(syncExtensionId)
    }
  })
  const isFirstRun = !initialState.get('seed') && !initialState.get('deviceId')
  ipcMain.on(syncMessages.SYNC_READY, module.exports.onSyncReady.bind(null,
    isFirstRun))
  ipcMain.on(syncMessages.SYNC_DEBUG, (e, msg) => {
    log(msg)
  })
  ipcMain.on(syncMessages.SYNC_SETUP_ERROR, (e, error) => {
    if (error === 'Failed to fetch') {
      // This is probably the most common error, so give it a more useful message.
      error = locale.translation('connectionError')
    }
    appActions.setSyncSetupError(error || locale.translation('unknownError'))
  })
  ipcMain.on(syncMessages.GET_EXISTING_OBJECTS, (event, categoryName, records) => {
    if (records.length > 0) {
      appActions.pendingSyncRecordsRemoved(records)
    }
    if (!syncUtil.syncEnabled()) {
      return
    }
    let devices = {}
    log(`getting existing objects for ${records.length} ${categoryName}`)
    if (!CATEGORY_NAMES.includes(categoryName) || !records || !records.length) {
      return
    }
    const recordsAndExistingObjects = records.map((record) => {
      const safeRecord = syncUtil.ipcSafeObject(record)
      const deviceId = syncUtil.deviceIdString(safeRecord.deviceId)
      devices[deviceId] = {lastRecordTimestamp: record.syncTimestamp}
      const existingObject = syncUtil.getExistingObject(categoryName, record)
      return [safeRecord, existingObject]
    })
    event.sender.send(syncMessages.RESOLVE_SYNC_RECORDS, categoryName, recordsAndExistingObjects)
    // For each device we saw, update its last record timestamp.
    appActions.saveSyncDevices(devices)
  })
  ipcMain.on(syncMessages.RESOLVED_SYNC_RECORDS, (event, categoryName, records) => {
    if (!records || !records.length) {
      return
    }
    if (!bookmarksToolbarShown && isFirstRun) {
      // syncing for the first time -- show toolbar if we were fresh and just added some bookmarks via Sync
      const bookmarks = bookmarksState.getBookmarksWithFolders(AppStore.getState())
      if (!bookmarks.size) {
        for (const record of records) {
          if (record && record.objectData === 'bookmark') {
            appActions.changeSetting(settings.SHOW_BOOKMARKS_TOOLBAR, true)
            bookmarksToolbarShown = true
            break
          }
        }
      }
    }
    syncUtil.applySyncRecords(records)
  })
  return appState
}

/**
 * Called when sync is disabled.
 */
module.exports.stop = function () {
  if (pollIntervalId !== null) {
    clearInterval(pollIntervalId)
  }
  appActions.setSyncSetupError(null)
  AppStore.removeChangeListener(appStoreChangeCallback)
}
