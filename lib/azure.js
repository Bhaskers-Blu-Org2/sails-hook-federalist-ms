/* global sails,_,async,process */

var fs = require('fs');
var path = require('path');
var url = require('url');
var FTPClient = require('ftp');
var c;
    
// Azure dependencies
var AuthenticationContext = require('adal-node').AuthenticationContext;
var common = require('azure-common');
var resourceManagement = require('azure-arm-resource');
var resourceManagementClient;
var webSiteManagement = require('azure-asm-website');
var webSiteManagementClient;
var tokenCreds;
var azurePublishConfig = {};
  
// FTP
var ftpHost;
var ftpUser;
var ftpPass;
var ftpFiles = [];
var ftpDirs = [];


/**
 * Azure site publishing
 * @module azure
 */
module.exports = {
         
  /**
   * Publish to Azure
   * 
   * @param {Object} publishConfig - Azure publishing configuration
   * @param {Function(Error)} done - callback function that takes an optional `Error` object
   */
  publish: function (publishConfig, done) {
    azurePublishConfig = {};

    // Combine hook deafults with publish config generated from successful build
    _.extend(azurePublishConfig, publishConfig, sails.config['federalist-ms'].azure);
    
    // Execute Azure deployment operation in series
    async.series([this._setToken, this._checkResources.bind(this), this._getPublishingCredentials, this._uploadContent.bind(this)], function onResult(err, results) {
      if (err) {
        return done(err);
      }
      done();
    });
  },
  
  /**
   * Retrieve authentication token for Azure
   * 
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _setToken: function (callback) {

    sails.log.verbose("Setting token...");

    var authorityUrl = azurePublishConfig.authorityUrl;
    var service = new AuthenticationContext(authorityUrl);
    var username = azurePublishConfig.username;
    var password = azurePublishConfig.password;
    var clientId = azurePublishConfig.clientId;
    var subscriptionId = azurePublishConfig.subscriptionId;

    if (!username || !password || !clientId || !subscriptionId) {
      return callback("Missing Azure configuration properties. Check to ensure appropriate environment variables have been set");
    }

    service.acquireTokenWithUsernamePassword('https://management.core.windows.net/', username, password, clientId, function onAcquisition(err, tokenResponse) {
      if (err) {
        return callback(err);
      }

      tokenCreds = new common.TokenCloudCredentials({
        subscriptionId: subscriptionId,
        token: tokenResponse.accessToken
      });

      resourceManagementClient = resourceManagement.createResourceManagementClient(tokenCreds);
      webSiteManagementClient = webSiteManagement.createWebSiteManagementClient(tokenCreds);

      sails.log.verbose("Token set");

      return callback(null, 'Token set');
    });
  },
  
  /**
   * Check existence of Azure resources in specified resource group/region
   *  
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _checkResources: function (callback) {
    var service = this;   
    var webSpace = azurePublishConfig.rgName + '-' + azurePublishConfig.region.replace(/ /g, '') + 'webspace';
    var siteName = azurePublishConfig.webAppName;
    
    sails.log.verbose("Determining whether or not Web App '" + siteName + "' already exists");

    function getWebSpace(cb) {
      webSiteManagementClient.webSpaces.get(webSpace, function onWebSpaceGet(err, result) {
        if (err) {
          return cb(err);
        }

        if (result) {
          sails.log.verbose("WebSpace '" + webSpace + "' already exists");
          cb(null, 'Web Space exists');
        }
      });
    }

    function getWebSite(cb) {
      webSiteManagementClient.webSites.get(webSpace, siteName, function onWebSiteGet(err, result) {
        if (err) {
          return cb(err);
        }

        if (result) {
          sails.log.verbose("Web App '" + siteName + "' already exists");
          cb(null, "Web App already exists");
        }
      });
    }

    async.series([getWebSpace, getWebSite], function (err, results) {
      if (err && err.code === 'NotFound') {
        sails.log.verbose("Web App '" + siteName + "' does not exist");
        service._deployResourceGroup(function onResourceGroupDeploy(rgErr, result) {
          if (rgErr) {
            return callback(rgErr);
          }

          callback(null, 'Resource Group deployed');
        });
      } else if (err) {
        return callback(err);
      } else {
        callback(null, 'Resources checked');
      }
    });

  },
  
  /**
   * Get Web App publishing credentials
   * 
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _getPublishingCredentials: function (callback) {
    var webSpace = azurePublishConfig.rgName + '-' + azurePublishConfig.region.replace(/ /g, '') + 'webspace';
    var siteName = azurePublishConfig.webAppName;

    sails.log.verbose("Getting Web App publishing credentials");
    webSiteManagementClient.webSites.getPublishProfile(webSpace, siteName, function onWebSiteGet(err, result) {
      if (err) {
        return callback(err);
      }

      for (var i = 0; i < result.publishProfiles.length; i++) {
        if (result.publishProfiles[i].publishMethod === 'FTP') {
          var profile = result.publishProfiles[i];
          var publishUrl = url.parse(profile.publishUrl);
          ftpHost = publishUrl.hostname;
          ftpUser = profile.userName;
          ftpPass = profile.userPassword;

          sails.log.verbose("FTPS Publish profile retrieved");

          return callback(null, 'FTPS Publish Profile retrieved');
        }
      }
    });
  },
  
  /**
   * Publish site content via FTPS
   * 
   * NOTE: May want to rework for Git publishing instead of FTPS
   * NOTE: Requires Node 0.10.x due to bug in TLS module as
   * described {@link https://github.com/joyent/node/issues/9272|here}
   * 
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _uploadContent: function (callback) {
    ftpDirs.length = 0;
    ftpFiles.length = 0;

    var service = this;
    c = new FTPClient();

    sails.log.verbose("Uploading site content via FTPS");
    
    c.on('ready', function onReady() {
      service._ftpWalk(azurePublishConfig.directory, function onWalk(err) {

        if (err) {
          return callback(err);
        }

        async.series([service._createFTPDirectories, service._uploadFTPFiles], function onResult(err, results) {
          c.end();
          sails.log.verbose("FTPS connection closed");

          if (err) {
            return callback(err);
          }
          callback(null, 'Files uploaded successfully');
        });
      });
    });

    c.connect({
      host: ftpHost,
      secure: true,
      user: ftpUser || process.env.FEDERALIST_AZURE_WEBAPP_DEPLOYMENT_USER,
      password: ftpPass || process.env.FEDERALIST_AZURE_WEBAPP_DEPLOYMENT_PASSWORD
    });
  },
  
  /**
   * Create new Resource Group and execute template deployment
   * 
   * @param {Function(Error)} done - callback function that takes an optional `Error` object
   */
  _deployResourceGroup: function (done) {
    var service = this;

    service._checkRGExistence(function onCheckResourceGroupExistence(err, exists, result) {
      if (err) {
        return done(err);
      }
      
      if (exists) {
        async.series([service._deployTemplate, service._checkDeploymentStatus], function onResult(err, results) {
          if (err) {
            return done(err);
          }
          done(null, results);
        });
      } else {
        async.series([service._createResourceGroup, service._deployTemplate, service._checkDeploymentStatus], function onResult(err, results) {
          if (err) {
            return done(err);
          }
          done(null, results);
        });
      }
    });
  },
  
  /**
   * Check existence of Resource Group
   * 
   * @param {Function(Error)} done - callback function that takes an optional `Error` object
   */
  _checkRGExistence: function (done) {
    var rgName = azurePublishConfig.rgName;
    
    sails.log.verbose("Checking existence of Resource Group '" + rgName + "'");

    resourceManagementClient.resourceGroups.checkExistence(rgName, function onCheckResourceGroupExistence(err, result) {
      // Bug in checkExistence() function that returns an error
      // instead of result.exists = false
      if (err && err.statusCode === 404 && err.code === 'NotFound') {
        sails.log.verbose("Resource Group '" + rgName + "' does not exist");
        return done(null, false, result);
      } else if (err) {
        return done(err);
      } else {
        sails.log.verbose("Resource Group '" + rgName + "' exists");
        done(null, true, result);
      }
    });
  },
  
  /**
   * Create new Resource Group
   * 
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _createResourceGroup: function (callback) {

    var rgName = azurePublishConfig.rgName;
    var params = {
      location: azurePublishConfig.region
    };

    sails.log.verbose("Creating Resource Group '" + rgName + "'");

    resourceManagementClient.resourceGroups.createOrUpdate(rgName, params, function onCreateResourceGroup(err, result) {
      if (err) {
        return callback(err);
      }

      sails.log.verbose("Resource Group '" + rgName + "' created successfully");
      callback(null, result);
    });
  },
  
  /**
   * Deploy generated template to Resource Group
   * 
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _deployTemplate: function (callback) {
  
    // Will replace with hosted template
    var templatePath = azurePublishConfig.rgTemplatePath;
    var template;
    var rgName = azurePublishConfig.rgName;
    var deploymentName = azurePublishConfig.rgDeploymentName;

    try {
      template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    } catch (err) {
      return callback(err);
    }

    // May decide to dynamically populate these parameters based on template JSON
    var params = {
      "properties": {
        "template": template,
        "mode": "Incremental",
        "parameters": {
          "siteName": {
            "value": azurePublishConfig.webAppName
          },
          "hostingPlanName": {
            "value": azurePublishConfig.appHostingPlanName
          },
          "siteLocation": {
            "value": azurePublishConfig.region
          }
        }
      }
    };

    sails.log.verbose("Deploying Template to Resource Group '" + rgName + "'");
    resourceManagementClient.deployments.createOrUpdate(rgName, deploymentName, params, function onResourceGroupDeployment(err, result) {
      if (err) {
        return callback(err);
      }

      sails.log.verbose("Resource Group Template deployment initiated");
      callback(null, result);
    });
  },
  
  /**
   * Check deployment status
   * 
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _checkDeploymentStatus: function (callback) {

    var rgName = azurePublishConfig.rgName;
    var deploymentName = azurePublishConfig.rgDeploymentName;

    sails.log.verbose("Getting status for template deployment '" + deploymentName + "' to Resource Group '" + rgName + "'");

    function checkStatus() {
      var statusInterval = setInterval(function onInterval() {
        resourceManagementClient.deployments.get(rgName, deploymentName, function onDeploymentGet(err, result) {
          if (err) {
            callback(err);
            clearInterval(statusInterval);
          }

          if (result && result.deployment.properties.provisioningState === 'Succeeded') {
            sails.log.verbose("Template deployment succeeded");

            callback(null, 'Template deployment succeeded');
            clearInterval(statusInterval);
          } else if (result && result.deployment.properties.provisioningState === 'Failed') {
            sails.log.verbose("Template deployment failed");
            callback('Template deployment failed');
            clearInterval(statusInterval);
          }
        });

        sails.log.verbose('Template deployment incomplete...waiting 10 seconds for status update');
      }, 10000);
    }

    checkStatus();
  },
  
  /**
   * Walk static site directory structure and copy paths
   * to global arrays
   * 
   * NOTE: may need to adjust path references
   * 
   * @param {string} dir - directory path
   * @param {Function(Error)} done - callback function that takes an optional `Error` object
   */
  _ftpWalk: function (dir, done) {

    var service = this;

    fs.readdir(dir, function onDirRead(err, list) {
      var pending = list.length;

      if (err) {
        return done(err);
      }
      if (!pending) {
        return done();
      }
      list.forEach(function onFile(file) {
        file = path.join(dir, file);
        fs.stat(file, function onStat(err, stat) {
          if (stat && stat.isDirectory()) {
            ftpDirs.push(file);
            service._ftpWalk(file, function onWalk(err, res) {
              if (err) {
                return done(err);
              }
              if (!--pending) {
                return done();
              }
            });
          } else {
            ftpFiles.push(file);
            if (!--pending) {
              done();
            }
          }
        });
      });
    });
  },
  
  /**
   * Create FTP directories
   * 
   * @param {Function(Error, results)} callback - callback function that takes an optional `Error` object and `results` parameter
   */
  _createFTPDirectories: function (callback) {
    async.each(ftpDirs, createDir, function onResult(err) {
      if (err) {
        return callback(err);
      }

      callback();
    });
    
    /**
     * Create directory
     * 
     * @param {string} dir - directory path
     * @param {Function(Error)} callback - callback function that takes an optional `Error` object
     */
    function createDir(dir, callback) {

      var ftpDir = path.join('/site/wwwroot/', path.relative(azurePublishConfig.directory, dir));
      ftpDir = ftpDir.replace(/\\/g, "/");

      c.mkdir(ftpDir, true, function onFtpMkDir(err) {
        if (err) {
          return callback(err);
        }

        sails.log.verbose("FTP directory '" + ftpDir + "' created");

        return callback();
      });
    }
  },
  
  /**
   * Upload files via FTP
   * 
   * @param {Function(Error)} callback - callback function that takes an optional `Error` object
   */
  _uploadFTPFiles: function (callback) {

    async.each(ftpFiles, uploadFile, function onResult(err) {
      if (err) {
        return callback(err);
      }
      callback();
    });
    
    /**
     * Upload file
     * 
     * @param {string} file - file path
     * @param {Function(Error)} callback - callback function that takes an optional `Error` object
     */
    function uploadFile(file, callback) {
  
      // Relative/absolute path normalization for Azure
      var localFile = path.join(process.cwd(), file);
      var ftpFile = path.join('/site/wwwroot/', path.relative(azurePublishConfig.directory, file));
      ftpFile = ftpFile.replace(/\\/g, "/");

      c.put(localFile, ftpFile, function onFtpPutFile(err) {
        if (err) {
          return callback(err);
        }

        sails.log.verbose("File '" + localFile + "' uploaded successfully to '" + ftpFile + "'");
        callback();
      });
    }
  },
  
  /**
   * Remove Resource Group and cleanup attempted
   * deployment operation
   * 
   * NOTE: Cleanup stubs for Resource Group provisioning failure
   * 
   * @param {Function(Error)} done - callback function that takes an optional `Error` object
   */
  cleanup: function (done) {
  
    // Delete Resource Group
    var rgName = azurePublishConfig.rgName;

    resourceManagementClient.resourceGroups.deleteMethod(rgName, function onResourceGroupDelete(err, result) {
      if (err) {
        return done(err);
      }

      sails.log.verbose("Resource Group '" + rgName + "' successfully purged");
      done(null, result);
    });
  }

};