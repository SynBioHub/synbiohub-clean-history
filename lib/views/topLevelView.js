
const { fetchSBOLObjectRecursive } = require('../fetch/fetch-sbol-object-recursive')
const { fetchSBOLObjectNonRecursive } = require('../fetch/fetch-sbol-object-non-recursive')
const { getContainingCollections } = require('../query/local/collection')
var retrieveCitations = require('../citations')
var loadTemplate = require('../loadTemplate')
var summarizeSBOL = require('../summarize/summarizeSBOL')
var pug = require('pug')
var sparql = require('../sparql/sparql-collate')
var config = require('../config')
var URI = require('sboljs').URI
var getUrisFromReq = require('../getUrisFromReq')
const uriToUrl = require('../uriToUrl')
const request = require('request')
var postprocessIgem = require('../postprocess_igem')
var striptags = require('striptags')
var generateDataRecord = require('../bioschemas/DataRecord')
var generateDataset = require('../bioschemas/Dataset')
var extend = require('xtend')
const plugins = require('../plugins')
const prefixify = require('../prefixify')
const getComponentDefinitionMetadata = require('../query/local/component-definition.js')

function getShortName (type) {
  console.log('type is ' + type)
  let typeShortName = 'Unknown'
  let lastHash = type.lastIndexOf('#')
  let lastSlash = type.lastIndexOf('/')

  if (lastHash >= 0 && lastHash + 1 < type.length) {
    typeShortName = type.slice(lastHash + 1)

    switch (typeShortName) {
      case 'Component':
        typeShortName = 'ComponentInstance'
        break
      case 'Module':
        typeShortName = 'ModuleInstance'
        break
      case 'ComponentDefinition':
        typeShortName = 'Component'
        break
      case 'ModuleDefinition':
        typeShortName = 'Module'
        break
    }
  } else if (lastSlash >= 0 && lastSlash + 1 < type.length) {
    typeShortName = type.slice(lastSlash + 1)
  }

  return typeShortName
}

module.exports = function (req, res, type) {
  let typeShortName = getShortName(type)

  var locals = {
    config: config.get(),
    section: typeShortName,
    user: req.user
  }

  var meta
  var sbol
  var topLevel
  var collectionIcon
  var remote

  var collections = []
  var submissionCitations = []
  var citations = []
  var builds = []

  var encodedProteins = []
  var otherComponents = []
  var mappings = {}

  var count

  const { graphUri, uri, share } = getUrisFromReq(req, res)

  var templateParams = {
    uri: uri
  }

  var getCitationsQuery = loadTemplate('sparql/GetCitations.sparql', templateParams)

  var getBuildsQuery = loadTemplate('sparql/GetImplementations.sparql', templateParams)

  var estimateSBOLSizeQuery = loadTemplate('sparql/EstimateSBOLSize.sparql', templateParams)

  var large = false

  sparql.queryJson(estimateSBOLSizeQuery, graphUri).then((result) => {
    count = 0
    if (result && result[0] && result[0].count !== undefined) {
      count = result[0].count
    }
  }).then(function (result) {
    if (typeShortName === 'Collection') {
      console.log('doing non-recurseive fetch of collection: ' + uri)
      return fetchSBOLObjectNonRecursive(uri, graphUri)
    } else if (config.get('fetchLimit') && count > config.get('fetchLimit') && !req.url.toString().endsWith('/full')) {
      console.log('SBOL size estimate of ' + count + ' is larger than fetch limit of ' + config.get('fetchLimit'))
      console.log('Performing non-recursive fetch of ' + uri)
      large = true
      return fetchSBOLObjectNonRecursive(uri, graphUri)
    } else {
      return fetchSBOLObjectRecursive(uri, graphUri)
    }
  }).then(function (result) {
    sbol = result.sbol
    topLevel = result.object
    remote = result.remote

    if (!topLevel || topLevel instanceof URI) {
      throw new Error(`${uri} record not found: ${topLevel}`)
    }

    meta = summarizeSBOL(typeShortName, topLevel, req, sbol, remote, graphUri)
    meta.large = large
  }).then(function lookupCollections () {
    return Promise.all([
      getContainingCollections(uri, graphUri, req.url).then((_collections) => {
        collections = _collections

        collections.forEach((collection) => {
          collection.url = uriToUrl(collection.uri)

          const collectionIcons = config.get('collectionIcons')

          if (collectionIcons[collection.uri]) { collectionIcon = collectionIcons[collection.uri] }
        })
      }),

      sparql.queryJson(getCitationsQuery, graphUri).then((results) => {
        citations = results
      }).then(() => {
        return retrieveCitations(citations).then((resolvedCitations) => {
          submissionCitations = resolvedCitations
        })
      }),

      sparql.queryJson(getBuildsQuery, graphUri).then((results) => {
        builds = results
        builds.forEach((build) => {
          build.url = uriToUrl(build.impl)
        })
      })

    ])
  }).then(function lookupEncodedProteins () {
    var query =
'PREFIX sybio: <http://w3id.org/sybio/ont#>\n' +
'SELECT ?subject WHERE {' +
'   ?subject sybio:encodedBy <' + uri + '>' +
'}'

    return sparql.queryJson(query, graphUri).then((results) => {
      encodedProteins = results.map((result) => {
        return result.subject
      })
    })
  }).then(function getOtherComponentMetaData () {
    if (meta.protein && meta.protein.encodedBy) { otherComponents = otherComponents.concat(meta.protein.encodedBy) }
    /* todo and subcomponents */

    otherComponents = otherComponents.concat(encodedProteins)

    return Promise.all(otherComponents.map((otherComponent) => {
      return getComponentDefinitionMetadata(otherComponent, graphUri).then((res) => {
        mappings[otherComponent] = res.metaData.name
      })
    }))
  }).then(function summarizeEncodedProteins () {
    meta.encodedProteins = encodedProteins.map((uri) => {
      return {
        uri: uri,
        name: mappings[uri],
        url: uri
      }
    })

    if (meta.protein) {
      if (meta.protein.encodedBy) {
        meta.protein.encodedBy = meta.protein.encodedBy.map((uri) => {
          var prefixified = prefixify(uri, [])

          return {
            uri: uri,
            name: mappings[uri],
            url: '/entry/' + prefixified.prefix + '/' + prefixified.uri
          }
        })
      }
    }
  }).then(function fetchFromIgem () {
    if (topLevel.wasDerivedFrom.toString().indexOf('http://parts.igem.org/') === 0) {
      return Promise.all([

        new Promise((resolve, reject) => {
          request.get(topLevel.wasDerivedFrom.toString() + '?action=render', function (err, res, body) {
            if (err) {
              resolve()
              // reject(err)
              return
            }

            if (res.statusCode >= 300) {
              resolve()
              // reject(new Error('HTTP ' + res.statusCode))
              return
            }

            meta.iGemMainPage = body
            if (meta.iGemMainPage.toString() !== '') {
              meta.iGemMainPage = postprocessIgem(meta.iGemMainPage.toString())
            }

            resolve()
          })
        }),

        new Promise((resolve, reject) => {
          request.get(topLevel.wasDerivedFrom.toString() + ':Design?action=render', function (err, res, body) {
            if (err) {
              // reject(err)
              resolve()
              return
            }

            if (res.statusCode >= 300) {
              // reject(new Error('HTTP ' + res.statusCode))
              resolve()
              return
            }

            meta.iGemDesign = body
            if (meta.iGemDesign.toString() !== '') {
              meta.iGemDesign = postprocessIgem(meta.iGemDesign.toString())
            }

            resolve()
          })
        }),

        new Promise((resolve, reject) => {
          request.get(topLevel.wasDerivedFrom.toString() + ':Experience?action=render', function (err, res, body) {
            if (err) {
              // reject(err)
              resolve()
              return
            }

            if (res.statusCode >= 300) {
              // reject(new Error('HTTP ' + res.statusCode))
              resolve()
              return
            }

            meta.iGemExperience = body
            if (meta.iGemExperience.toString() !== '') {
              meta.iGemExperience = postprocessIgem(meta.iGemExperience.toString())
            }

            resolve()
          })
        })

      ])
    } else {
      return Promise.resolve()
    }
  }).then(function setupPlugins () {
    // Construct the request to send to each plugin
    let access = share

    if (graphUri == null) {
      access = uri
    }

    let data = {
      complete_sbol: access + '/sbol',
      shallow_sbol: access + '/sbolnr',
      top_level: topLevel.uri.toString(),
      size: count
    }

    locals.renderingPlugins = config.get('plugins').rendering.map(plugin => {
      let safeName = plugin.name.replace(/[\W_]+/g, '_')

      let streamId = plugins.callPlugin(plugin, data)

      return {
        safeName: safeName,
        name: plugin.name,
        stream: streamId
      }
    })

    locals.downloadPlugins = config.get('plugins').download.map(plugin => {
      let safeName = plugin.name.replace(/[\W_]+/g, '_')

      let streamId = plugins.callPlugin(plugin, data)

      return {
        safeName: safeName,
        name: plugin.name,
        stream: streamId
      }
    })

    return Promise.resolve()
  }).then(function renderView () {
    locals.meta = meta

    // Code for generating bioschemas
    locals.metaDesc = striptags(locals.meta.description).trim()
    locals.title = locals.meta.name + ' ‒ ' + config.get('instanceName')
    if (typeShortName === 'Collection') {
      locals.bioschemas = generateDataset(extend(locals.meta, { uri, colUrl: uri }))
    } else {
      locals.bioschemas = generateDataRecord(extend(locals.meta, { uri, rdfType: 'https://bioschemas.org/BioChemEntity' }))
      // locals.bioschemas = generateDataRecord(extend(locals.meta, { uri }))
    }

    if (type.startsWith('http://sbols.org/v2#')) {
      locals.rdfType = {
        name: typeShortName,
        url: type.replace('http://sbols.org', 'http://sbolstandard.org')
      }
    } else {
      locals.rdfType = {
        name: typeShortName,
        url: type
      }
    }

    locals.share = share
    locals.prefix = req.params.prefix

    locals.collections = collections
    locals.collectionIcon = collectionIcon
    locals.builds = builds

    locals.submissionCitations = submissionCitations
    locals.citationsSource = citations.map(function (citation) {
      return citation.citation
    }).join(',')

    if (typeShortName === 'Activity' || typeShortName === 'Agent' || typeShortName === 'Attachment' ||
typeShortName === 'Implementation' || typeShortName === 'Model' || typeShortName === 'Plan' ||
typeShortName === 'Sequence' || typeShortName === 'CombinatorialDerivation' || typeShortName === 'Experiment' ||
typeShortName === 'ComponentInstance' || typeShortName === 'FunctionalComponent' || typeShortName === 'ExperimentalData' ||
typeShortName === 'MapsTo' || typeShortName === 'SequenceAnnotation' || typeShortName === 'SequenceConstraint' ||
typeShortName === 'Location' || typeShortName === 'Range' || typeShortName === 'Cut' ||
typeShortName === 'GenericLocation' || typeShortName === 'ModuleInstance' || typeShortName === 'Measure' ||
typeShortName === 'Interaction' || typeShortName === 'Participation' ||
typeShortName === 'VariableComponent' || typeShortName === 'Collection' ||
typeShortName === 'Usage' || typeShortName === 'Association') {
      res.send(pug.renderFile('templates/views/' + typeShortName.toLowerCase() + '.jade', locals))
    } else if (typeShortName === 'Component' || typeShortName === 'Module') {
      res.send(pug.renderFile('templates/views/' + typeShortName.toLowerCase() + 'Definition.jade', locals))
    } else {
      res.send(pug.renderFile('templates/views/genericTopLevel.jade', locals))
    }
  }).catch((err) => {
    locals = {
      config: config.get(),
      section: 'errors',
      user: req.user,
      errors: [ err ]
    }
    console.log(err.stack)
    res.send(pug.renderFile('templates/views/errors/errors.jade', locals))
  })
}
