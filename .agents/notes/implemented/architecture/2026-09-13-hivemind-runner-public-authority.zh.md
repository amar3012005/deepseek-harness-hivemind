# Agent Note: HIVE runner uses the proxy-pinned public authority

Status: implemented

[English](2026-09-13-hivemind-runner-public-authority.md) | 中文

## Problem

嵌入式 HIVE runner 可能位于 Worker 和隧道之后。即使上游 `Host` 已固定为浏览器可见的应用地址，隧道仍可能把自己的传输主机名追加到 `x-forwarded-host`。优先选择转发值会拒绝有效的父级来源，并可能把 Connection Cookie 校验绑定到错误的地址。

## Decision

部署反向代理把上游 `Host` 固定为浏览器可见的应用地址。runner 使用 `Host` 执行同源准入、创建 Connection Cookie 和完成已认证的浏览器启动。仅当 `Host` 缺失时，runner 才读取第一个 `x-forwarded-host` 值。

票据及其 Redis nonce 仍然是强制要求。地址选择本身不会授予准入，也不会削弱明确的父级来源允许列表。

## Alternatives considered

**优先信任 `x-forwarded-host`。** 拒绝该方案，因为传输代理可能加入浏览器从未看到的主机名。

**增加另一个共享边缘密钥和自定义地址请求头。** 拒绝该方案，因为签名的一次性票据、nonce 消费、父级来源允许列表和受信任代理的 Host 已经对该路径完成认证和约束；额外密钥只会复制部署状态，而不会强化该决定。

## Consequences

反向代理必须明确设置 `Host`，不能传递任意客户端值。直接回环使用继续采用普通请求 Host，没有 Host 的部署继续使用转发主机回退。
