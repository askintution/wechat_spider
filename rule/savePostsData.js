'use strict';

const url = require('url');
const moment = require('moment');
const cheerio = require('cheerio');
const models = require('../models');
const logger = require('../utils/logger');
const redis = require('../utils/redis');
const config = require('../config');
const helper = require('../utils/helper');
const ContentHandler = require('../utils/contentHandler');

const {
  redis: redisConfig,
  rule: ruleConfig,
} = config;

const {
  page: pageConfig,
} = ruleConfig;

// 链接数组的缓存 每次重启程序后都会清空
const { PROFILE_LIST_KEY } = redisConfig;

// 性能较好的查询公众号数据库
class FindProfileHandler {
  constructor() {
    this.profileMap = new Map();
    this.profileWaitingMap = new Map();
  }

  async find(biz) {
    let doc = this.profileMap.get(biz);
    if (doc || doc === null) return doc;

    let waitingList = this.profileWaitingMap.get(biz);
    if (!waitingList) {
      // 首次
      waitingList = [];
      this.profileWaitingMap.set(biz, waitingList);

      doc = await models.Profile.findOne({ msgBiz: biz });
      if (!doc) doc = null;
      this.profileMap.set(biz, doc);

      // trigger
      for (const triggerFn of waitingList) {
        triggerFn(doc);
      }

      this.profileWaitingMap.delete(biz);

      return doc;
    } else {
      return await new Promise(resolve => {
        const triggerFn = doc => resolve(doc);
        waitingList.push(triggerFn);
        // logger.debug('[waitingList] len: %s', waitingList.length);
      });
    }
  }
}

// 存文章基本信息至数据库
async function savePostsData(postList) {
  const posts = [];
  postList.forEach(post => {
    const appMsg = post.app_msg_ext_info;
    if (!appMsg) return;
    const publishAt = new Date(post.comm_msg_info.datetime * 1000);
    posts.push({ appMsg, publishAt });

    const multiAppMsg = appMsg.multi_app_msg_item_list;
    if (!(multiAppMsg && multiAppMsg.length > 0)) return;
    multiAppMsg.forEach(appMsg => {
      posts.push({ appMsg, publishAt });
    });
  });

  // 查找 profile 辅助方法
  const findProfileHandler = new FindProfileHandler();

  let savedPosts = await Promise.all(posts.map(async post => {
    const { appMsg, publishAt } = post;
    let { title, content_url: link } = appMsg;
    if (!(title && link)) return;

    link = helper.escape2Html(link);
    title = helper.escape2Html(title);

    const urlObj = url.parse(link, true);
    const { query } = urlObj;
    const { __biz, mid, idx } = query;
    const [msgBiz, msgMid, msgIdx] = [__biz, mid, idx];

    const { cover, digest, source_url: sourceUrl, author, copyright_stat: copyrightStat } = appMsg;

    const updateQuery = { $set: { title, link, publishAt, cover, digest, sourceUrl, author, copyrightStat } };

    return models.Post.findOneAndUpdate(
      { msgBiz, msgMid, msgIdx },
      updateQuery,
      { new: true, upsert: true }
    );
  }));

  savedPosts = savedPosts.filter(p => p);

  if (savedPosts.length) {
    const profile = await findProfileHandler.find(savedPosts[0].msgBiz);
    if (profile && profile.title) {
      logger.info('[profile] msgBiz: %s, title: %s', savedPosts[0].msgBiz, profile.title);
    }
  }

  savedPosts.forEach(post => {
    logger.info('[抓取历史文章] 发布时间: %s, 标题: %s', post.publishAt ? moment(post.publishAt).format('YYYY-MM-DD HH:mm') : '', post.title);
  });

  // 记录公众号的发布记录
  await models.ProfilePubRecord.savePubRecords(savedPosts);

  await redis('llen', PROFILE_LIST_KEY).then(len => {
    logger.info('剩余公众号抓取长度: %s', len);
  });

  return savedPosts;
}


// link 必传
// body 可不传
async function getPostDetail(link, body) {
  console.log('url:', link);
  if (!link) return;
  const ch = new ContentHandler({ link, body });

  const { msgBiz, msgMid, msgIdx } = await ch.getIdentifying();

  if (!msgBiz || !msgMid || !msgIdx) {
    logger.warn('[getPostDetail] can not get identify, link: %s', link);
    return;
  }

  body = await ch.getBody();

  console.log("global_error_msg:", body.indexOf('global_error_msg') > -1 || body.indexOf('icon_msg warn') > -1);

  // 判断此文是否失效
  if (body.indexOf('global_error_msg') > -1 || body.indexOf('icon_msg warn') > -1) {
    await models.Post.findOneAndUpdate(
      { msgBiz, msgMid, msgIdx },
      { isFail: true },
      { upsert: true }
    );
    return;
  }


  // 从 html 中提取必要信息
  const getTarget = regexp => {
    let target;
    body.replace(regexp, (_, t) => {
      target = t;
    });
    return target;
  };

  let wechatId = getTarget(/<span class="profile_meta_value">(.+?)<\/span>/);
  const username = getTarget(/var user_name = "(.+?)"/);
  // 如果上面找到的微信id中包含中文字符 则证明此微信号没有设置微信id 则取微信给定的 username 初始字段
  if (wechatId && /[\u4e00-\u9fa5]/.test(wechatId)) {
    wechatId = username;
  }
  const title = getTarget(/var msg_title = "(.+?)";/);
  let publishAt = getTarget(/var ct = "(\d+)";/);
  if (publishAt) publishAt = new Date(parseInt(publishAt) * 1000);
  const sourceUrl = getTarget(/var msg_source_url = '(.*?)';/);
  const cover = getTarget(/var msg_cdn_url = "(.+?)";/);
  const digest = getTarget(/var msg_desc = "(.+?)";/);

  // 公众号头像
  const headimg = getTarget(/var hd_head_img = "(.+?)"/);
  const nickname = getTarget(/var nickname = "(.+?)"/);


  // 从数据库中先查找文章
  const doc = await models.Post.findOne({ msgBiz, msgMid, msgIdx });

  // 如果文章可以找到，且各字段数据都有，就不必再存一次了
  if (!(doc && doc.title && doc.link && doc.wechatId)) {
    const updateObj = { msgBiz, msgMid, msgIdx, link };
    if (title) updateObj.title = title;
    if (wechatId) updateObj.wechatId = wechatId;
    if (publishAt) updateObj.publishAt = publishAt;
    if (sourceUrl) updateObj.sourceUrl = sourceUrl;
    if (cover) updateObj.cover = cover;
    if (digest) updateObj.digest = digest;

    await models.Post.findOneAndUpdate(
      { msgBiz, msgMid, msgIdx },
      { $set: updateObj },
      { upsert: true }
    );
    logger.info('[save post basic info] %s %s %s %s', msgBiz, msgMid, msgIdx, title);
  }

  // 从数据库中查找对应的公众号
  const profile = await models.Profile.findOne({ msgBiz });
  if (!(profile && profile.wechatId && profile.username && profile.headimg)) {
    const updateObj = { msgBiz };
    if (nickname) updateObj.title = nickname;
    if (wechatId) updateObj.wechatId = wechatId;
    if (username) updateObj.username = username;
    if (headimg) updateObj.headimg = headimg;
    await models.Profile.findOneAndUpdate(
      { msgBiz },
      { $set: updateObj },
      { upsert: true }
    );
    logger.info('[save profile basic info from post] %s %s %s %s %s', msgBiz, nickname, wechatId, username, headimg);
  }


  console.log("pageConfig.isSavePostContent:", pageConfig.isSavePostContent);

  // 保存正文内容
  if (pageConfig.isSavePostContent) {
    let shouldSaveToDb = true;

    if (doc) {
      if (doc.html && pageConfig.saveContentType === 'html') {
        shouldSaveToDb = true;
      } else if (doc.content && pageConfig.saveContentType === 'text') {
        shouldSaveToDb = true;
      }
    }

    console.log("shouldSaveToDb:", shouldSaveToDb);

    if (shouldSaveToDb) {
      const $ = cheerio.load(body, { decodeEntities: false });
      let content, html;

      if (pageConfig.saveContentType === 'html') {
        html = $('#js_content').html() || '';
        // content = $('#js_content').text() || '';
      } else {
        // content = $('#js_content').text() || '';
      }

      // if (content) content = content.trim();
      if (html) html = html = html.trim();

      if (content || html) {
        const updateObj = { msgBiz, msgMid, msgIdx };
        // if (content) updateObj.content = content;
        if (html) updateObj.html = html;
        updateObj.viewed = true;
        updateObj.imported = false;
        await models.Post.findOneAndUpdate(
          { msgBiz, msgMid, msgIdx },
          { $set: updateObj },
          { upsert: true }
        );
        logger.info('[save post content] %s %s %s %s', msgBiz, msgMid, msgIdx, title);
      }
    }
  }
}

async function upsertPosts(posts) {
  if (!posts) return;
  let isArray = Array.isArray(posts);
  if (!isArray) posts = [posts];

  const res = await Promise.all(posts.map(async post => {
    const { msgBiz, msgMid, msgIdx } = post;
    if (!msgBiz || !msgMid || !msgIdx) return null;

    const updateQuery = { $set: post };

    return await models.Post.findOneAndUpdate(
      { msgBiz, msgMid, msgIdx },
      updateQuery,
      { new: true, upsert: true }
    );
  }));

  if (isArray) return res;
  return res[0];
}

exports = module.exports = savePostsData;
exports.getPostDetail = getPostDetail;
exports.FindProfileHandler = FindProfileHandler;
exports.upsertPosts = upsertPosts;
